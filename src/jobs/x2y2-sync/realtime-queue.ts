import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import {redis, extendLock, releaseLock} from "../../common/redis";
import { fetchOrdersByCursor, fetchOrdersByDateCreated } from "./utils";
import { logger } from "../../common/logger";
import { config } from "../../config";

const REALTIME_QUEUE_NAME = "realtime-x2y2-sync";

export const realtimeQueue = new Queue(REALTIME_QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 1,
    backoff: {
      type: "fixed",
      delay: 3,
    },
    timeout: 60000,
    removeOnComplete: 100,
    removeOnFail: 1000,
  },
});
new QueueScheduler(REALTIME_QUEUE_NAME, { connection: redis.duplicate() });

if (config.doRealtimeWork) {
  const realtimeWorker = new Worker(
    REALTIME_QUEUE_NAME,
    async (job: Job) => {
      try {
        const cacheKey = "x2y2-sync-cursor";
        let cursor = await redis.get(cacheKey);

        const newCursor = await fetchOrdersByCursor(cursor || "");

        if (newCursor == cursor) {
          logger.info(
            REALTIME_QUEUE_NAME,
            `x2y2 cursor didn't change cursor=${cursor}, newCursor=${newCursor}`
          );
        }

        // Set the new cursor for the next job
        if (newCursor) {
          await redis.set(cacheKey, newCursor);
        }
      } catch (error) {
        logger.error(
          REALTIME_QUEUE_NAME,
          `X2Y2 Sync failed attempts=${job.attemptsMade}, error=${error}`
        );
      }
    },
    { connection: redis.duplicate(), concurrency: 2 }
  );

  realtimeWorker.on("completed", async (job) => {
    // Release the lock to allow the next sync
    await releaseLock("x2y2-sync-lock", false);

    if (job.attemptsMade > 0) {
      logger.info(REALTIME_QUEUE_NAME, `Sync recover attempts=${job.attemptsMade}`);
    }
  });

  realtimeWorker.on("error", (error) => {
    logger.error(REALTIME_QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const addToRealtimeQueue = async (delayMs: number = 0) => {
  await realtimeQueue.add(REALTIME_QUEUE_NAME, {}, { delay: delayMs });
};
