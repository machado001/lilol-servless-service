"use strict";


const {setGlobalOptions} = require("firebase-functions/v2");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

setGlobalOptions({maxInstances: 10});

const riotKeySecret = defineSecret("RIOT_KEY");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// eslint-disable-next-line valid-jsdoc
/**
 * Helper: Fetch rotation from Riot API and return { payload, rateInfo }.
 * Uses the given Riot API key.
 */
async function fetchRiotRotation(riotApiKey) {
  const url =
        "https://br1.api.riotgames.com/lol/platform/v3/champion-rotations";

  const response = await fetch(url, {
    headers: {
      "X-Riot-Token": riotApiKey,
    },
  });

  console.log(riotApiKey);

  const rateInfo = {
    app: response.headers.get("x-app-rate-limit"),
    appCount: response.headers.get("x-app-rate-limit-count"),
    method: response.headers.get("x-method-rate-limit"),
    methodCount: response.headers.get("x-method-rate-limit-count"),
  };

  if (!response.ok) {
    const errorBody = await response.text();
    let upstreamMessage;
    try {
      const parsed = JSON.parse(errorBody);
      upstreamMessage =
                (parsed.status && parsed.status.message) ||
                parsed.message ||
                JSON.stringify(parsed).slice(0, 2000);
    } catch (err) {
      upstreamMessage = errorBody.slice(0, 2000);
    }

    logger.error("Riot API error", {
      status: response.status,
      rateInfo,
      upstreamMessage,
    });

    const error = new Error("Upstream Riot API error");
    error.status = response.status;
    error.rateInfo = rateInfo;
    error.upstreamMessage = upstreamMessage;
    throw error;
  }

  const payload = await response.json();
  return {payload, rateInfo};
}

// eslint-disable-next-line valid-jsdoc
/**
 * Helper: Get Riot API key from secret or env vars.
 * Called inside functions so `riotKeySecret.value()` is valid.
 */
function resolveRiotApiKey() {
  let riotApiKey;

  try {
    // If defined as Firebase Secret RIOT_KEY
    riotApiKey = riotKeySecret.value();
  } catch (secretError) {
    logger.warn("Unable to read RIOT_KEY secret, falling back to env/config", {
      error: secretError && secretError.message,
    });
  }

  riotApiKey =
        riotApiKey ||
        process.env.RIOT_KEY ||
        process.env.RIOT_API_KEY ||
        process.env.RIOT_TOKEN;

  return riotApiKey;
}

/**
 * Callable function:
 * Proxies Riot's champion rotation endpoint without exposing the API key
 * to clients. Enforces App Check.
 */
exports.championRotation = onCall(
    {
      secrets: [riotKeySecret],
      enforceAppCheck: true,
    },
    async (request) => {
      // App Check is automatically enforced by the options above.
      // request.auth and request.app contain auth/app context if needed.

      const riotApiKey = resolveRiotApiKey();

      if (!riotApiKey) {
        logger.error("Riot API key is not configured");
        throw new HttpsError("internal", "Backend misconfiguration");
      }

      try {
        const {payload} = await fetchRiotRotation(riotApiKey);
        return payload;
      } catch (error) {
        if (error.status) {
          // Map upstream HTTP status codes to HttpsError codes
          let code = "internal";
          if (error.status === 400) code = "invalid-argument";
          if (error.status === 401) code = "unauthenticated";
          if (error.status === 403) code = "permission-denied";
          if (error.status === 404) code = "not-found";
          if (error.status === 429) code = "resource-exhausted";

          throw new HttpsError(code, "Upstream Riot API error", {
            status: error.status,
            rateInfo: error.rateInfo,
            upstreamMessage: error.upstreamMessage,
          });
        } else {
          logger.error("Failed to reach Riot API", {error});
          throw new HttpsError("internal", "Failed to contact Riot API");
        }
      }
    },
);

/**
 * Scheduled function:
 * Runs periodically (every 6 hours) to:
 *  - Fetch Riot champion rotation.
 *  - Compare with last stored rotation in Firestore (riot/rotation).
 *  - If changed:
 *      - Save new rotation.
 *      - Send FCM topic notification to "riot-rotation".
 */
exports.checkChampionRotation = onSchedule(
    {
      // Cron: minute hour day-of-month month day-of-week
      // "0 */6 * * *" = every 6 hours at minute 0
      schedule: "0 */6 * * *",
      timeZone: "America/Sao_Paulo",
      secrets: [riotKeySecret],
    },
    async (event) => {
      logger.info("Running scheduled Riot rotation check...");

      const riotApiKey = resolveRiotApiKey();

      if (!riotApiKey) {
        logger.error("Riot API key is not configured for scheduled function");
        return;
      }

      try {
        const {payload} = await fetchRiotRotation(riotApiKey);

        // Riot response usually has freeChampionIds: number[]
        const ids = Array.isArray(payload.freeChampionIds) ?
                payload.freeChampionIds.slice() :
                [];

        ids.sort((a, b) => a - b);
        const signature = ids.join(",");

        const docRef = db.collection("riot").doc("rotation");
        const snapshot = await docRef.get();
        // eslint-disable-next-line max-len
        const prevSignature = snapshot.exists ? snapshot.data().signature : null;

        if (prevSignature === signature) {
          logger.info("Rotation unchanged, nothing to do.");
          return;
        }

        // Save new rotation to Firestore
        await docRef.set({
          signature,
          freeChampionIds: ids,
          rawResponse: payload, // remove if you don't want full payload
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info(
            // eslint-disable-next-line max-len
            "New rotation detected and saved. Sending FCM notification to topic 'riot-rotation'...",
        );

        // Send FCM notification to topic
        const message = {
          notification: {
            title: "New free champion rotation!",
            // eslint-disable-next-line max-len
            body: "This week’s free champions are live. Open the app to check them out.",
          },
          topic: "riot-rotation",
        };

        const response = await messaging.send(message);
        logger.info("FCM notification sent", {response});
      } catch (error) {
        logger.error("Error in scheduled rotation check", {error});
      }
    },
);
