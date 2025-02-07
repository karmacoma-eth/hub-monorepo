import { bytesToHexString, HubAsyncResult, HubError, OnChainEvent, toFarcasterTime } from "@farcaster/hub-nodejs";
import { err, ok, Result, ResultAsync } from "neverthrow";
import cron from "node-cron";
import { logger } from "../../utils/logger.js";
import { FID_BYTES, TSHASH_LENGTH, UserMessagePostfixMax, UserPostfix } from "../db/types.js";
import RocksDB from "../db/rocksdb.js";
import Engine from "../engine/index.js";
import { makeUserKey, messageDecode } from "../db/message.js";
import { statsd } from "../../utils/statsd.js";
import { getHubState, putHubState } from "../../storage/db/hubState.js";

export const DEFAULT_VALIDATE_AND_REVOKE_MESSAGES_CRON = "0 1 * * *"; // Every day at 01:00 UTC

const log = logger.child({
  component: "ValidateOrRevokeMessagesJob",
});

type SchedulerStatus = "started" | "stopped";

export class ValidateOrRevokeMessagesJobScheduler {
  private _db: RocksDB;
  private _engine: Engine;
  private _cronTask?: cron.ScheduledTask;
  private _running = false;

  constructor(db: RocksDB, engine: Engine) {
    this._db = db;
    this._engine = engine;
  }

  start(cronSchedule?: string) {
    this._cronTask = cron.schedule(cronSchedule ?? DEFAULT_VALIDATE_AND_REVOKE_MESSAGES_CRON, () => this.doJobs());
  }

  stop() {
    if (this._cronTask) {
      this._cronTask.stop();
    }
  }

  status(): SchedulerStatus {
    return this._cronTask ? "started" : "stopped";
  }

  async doJobs(): HubAsyncResult<number> {
    if (this._running) {
      log.info({}, "ValidateOrRevokeMessagesJob already running, skipping");
      return ok(0);
    }

    const hubStateResult = await ResultAsync.fromPromise(getHubState(this._db), (e) => e as HubError);
    if (hubStateResult.isErr()) {
      log.error({ errCode: hubStateResult.error.errCode }, `error getting hub state: ${hubStateResult.error.message}`);
      return err(hubStateResult.error);
    }
    let hubState = hubStateResult.value;

    const lastJobTimestamp = hubState.validateOrRevokeState?.lastJobTimestamp ?? 0;
    const lastFid = hubState.validateOrRevokeState?.lastFid ?? 0;

    log.info({ lastJobTimestamp, lastFid }, "ValidateOrRevokeMessagesJob: starting");

    this._running = true;
    let totalMessagesChecked = 0;
    let totalFidsChecked = 0;

    const start = Date.now();

    let finished = false;
    let pageToken: Uint8Array | undefined;
    do {
      const fidsPage = await this._engine.getFids({ pageToken, pageSize: 100 });
      if (fidsPage.isErr()) {
        return err(fidsPage.error);
      }

      const { fids, nextPageToken } = fidsPage.value;
      if (!nextPageToken) {
        finished = true;
      } else {
        pageToken = nextPageToken;
      }

      for (let i = 0; i < fids.length; i++) {
        const fid = fids[i] as number;

        if (lastFid > 0 && fid < lastFid) {
          continue;
        }

        const numChecked = await this.doJobForFid(lastJobTimestamp, fid);
        const numUsernamesChecked = await this.doUsernamesJobForFid(fid);

        totalMessagesChecked += numChecked.unwrapOr(0) + numUsernamesChecked.unwrapOr(0);
        totalFidsChecked += 1;

        if (totalFidsChecked % 5000 === 0) {
          log.info({ fid, totalMessagesChecked, totalFidsChecked }, "ValidateOrRevokeMessagesJob: progress");

          // Also write the hub state to the database every 1000 FIDs, so that we can recover from
          // unfinished job
          const hubState = await getHubState(this._db);
          hubState.validateOrRevokeState = {
            lastFid: fid,
            lastJobTimestamp,
          };
          await putHubState(this._db, hubState);
        }
      }
    } while (!finished);

    const timeTakenMs = Date.now() - start;
    log.info({ timeTakenMs, totalFidsChecked, totalMessagesChecked }, "finished ValidateOrRevokeMessagesJob");
    hubState = await getHubState(this._db);
    hubState.validateOrRevokeState = {
      lastFid: 0,
      lastJobTimestamp: toFarcasterTime(start).unwrapOr(0),
    };
    await putHubState(this._db, hubState);

    // StatsD metrics
    statsd().timing("validateOrRevokeMessagesJob.timeTakenMs", timeTakenMs);
    statsd().gauge("validateOrRevokeMessagesJob.totalMessagesChecked", totalMessagesChecked);

    this._running = false;
    return ok(totalMessagesChecked);
  }

  /**
   * Check if any signers for this FID have changed since the last time the job ran, and if so,
   * validate or revoke any messages that are affected.
   */
  async doJobForFid(lastJobTimestamp: number, fid: number): HubAsyncResult<number> {
    const prefix = makeUserKey(fid);

    const allSigners: OnChainEvent[] = [];
    let finished = false;
    let pageToken: Uint8Array | undefined;

    do {
      // First, find if any signers have changed since the last time the job ran
      const signers = await this._engine.getOnChainSignersByFid(fid);
      if (signers.isErr()) {
        log.error(
          { errCode: signers.error.errCode },
          `error getting on-chain signers for FID ${fid}: ${signers.error.message}`,
        );
        return err(signers.error);
      }

      const { events, nextPageToken } = signers.value;
      if (!nextPageToken) {
        finished = true;
      } else {
        pageToken = nextPageToken;
      }
      allSigners.push(...events);
    } while (!finished);

    // Find the newest signer event
    const latestSignerEventTs = toFarcasterTime(
      1000 *
        allSigners.reduce((acc, signer) => {
          return acc > signer.blockTimestamp ? acc : signer.blockTimestamp;
        }, 0),
    ).unwrapOr(0);

    if (latestSignerEventTs < lastJobTimestamp) {
      return ok(0);
    }

    log.info({ fid, lastJobTimestamp, latestSignerEventTs }, "ValidateOrRevokeMessagesJob: checking FID");

    let count = 0;
    await this._db.forEachIteratorByPrefix(
      prefix,
      async (key, value) => {
        if ((key as Buffer).length !== 1 + FID_BYTES + 1 + TSHASH_LENGTH) {
          // Not a message key, so we can skip it.
          return; // continue
        }

        // Get the UserMessagePostfix from the key, which is the 1 + 32 bytes from the start
        const postfix = (key as Buffer).readUint8(1 + FID_BYTES);
        if (postfix > UserMessagePostfixMax) {
          // Not a message key, so we can skip it.
          return; // continue
        }

        const message = Result.fromThrowable(
          () => messageDecode(new Uint8Array(value as Buffer)),
          (e) => e as HubError,
        )();

        if (message.isOk()) {
          const result = await this._engine.validateOrRevokeMessage(message.value);
          count += 1;
          result.match(
            (result) => {
              if (result !== undefined) {
                log.info({ fid, hash: bytesToHexString(message.value.hash)._unsafeUnwrap() }, "revoked message");
              }
            },
            (e) => {
              log.error({ errCode: e.errCode }, `error validating and revoking message: ${e.message}`);
            },
          );
        }
      },
      {},
      15 * 60 * 1000, // 15 minutes
    );

    return ok(count);
  }

  /**
   * We'll also check for any username proof messages that need to be revoked, in case the user
   * has changed their username/reset the ENS since the last time the job ran.
   * We run this irrespective of the lastJobTimestamp
   */
  async doUsernamesJobForFid(fid: number): HubAsyncResult<number> {
    const prefix = makeUserKey(fid);
    let count = 0;

    await this._db.forEachIteratorByPrefix(
      prefix,
      async (key, value) => {
        if ((key as Buffer).length !== 1 + FID_BYTES + 1 + TSHASH_LENGTH) {
          // Not a message key, so we can skip it.
          return; // continue
        }

        // Get the UserMessagePostfix from the key, which is the 1 + 32 bytes from the start
        const postfix = (key as Buffer).readUint8(1 + FID_BYTES);
        if (postfix !== UserPostfix.UsernameProofMessage && postfix !== UserPostfix.UserDataMessage) {
          // Not a user name proof key, so we can skip it.
          return; // continue
        }

        const message = Result.fromThrowable(
          () => messageDecode(new Uint8Array(value as Buffer)),
          (e) => e as HubError,
        )();

        if (message.isOk()) {
          const result = await this._engine.validateOrRevokeMessage(message.value);
          count += 1;
          result.match(
            (result) => {
              if (result !== undefined) {
                log.info({ fid, hash: bytesToHexString(message.value.hash)._unsafeUnwrap() }, "revoked message");
              }
            },
            (e) => {
              log.error({ errCode: e.errCode }, `error validating and revoking message: ${e.message}`);
            },
          );
        }
      },
      {},
      15 * 60 * 1000, // 15 minutes
    );

    return ok(count);
  }
}
