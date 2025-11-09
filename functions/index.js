/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {setGlobalOptions} = require("firebase-functions/v2");
const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const riotKeySecret = defineSecret("RIOT_KEY");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

/**
 * Proxies Riot's champion rotation endpoint without exposing the API key
 * to clients. Requires the key via functions config (riot.token) or the
 * RIOT_API_KEY / RIOT_TOKEN environment variables.
 */
exports.championRotation = onRequest({
  secrets: [riotKeySecret],
}, async (req, res) => {
  if (req.method !== "GET") {
    res.set("Allow", "GET").status(405).json({error: "Only GET is supported"});
    return;
  }

  let riotApiKey;
  try {
    riotApiKey = riotKeySecret.value();
  } catch (secretError) {
    logger.warn("Unable to read RIOT_KEY secret, falling back to env/config", {
      error: secretError.message,
    });
  }
  riotApiKey =
    riotApiKey ||
    process.env.RIOT_KEY ||
    process.env.RIOT_API_KEY ||
    process.env.RIOT_TOKEN;

  if (!riotApiKey) {
    logger.error("Riot API key is not configured");
    res.status(500).json({error: "Backend misconfiguration"});
    return;
  }

  try {
    const response = await fetch(
        "https://br1.api.riotgames.com/lol/platform/v3/champion-rotations",
        {
          headers: {
            "X-Riot-Token": riotApiKey,
          },
        },
    );

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
          parsed.status?.message ||
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
      res.status(response.status).json({
        error: "Upstream Riot API error",
        status: response.status,
        rateInfo,
        upstreamMessage,
      });
      return;
    }

    const payload = await response.json();

    res.status(200).json(payload);
  } catch (error) {
    logger.error("Failed to reach Riot API", {error});
    res.status(500).json({error: "Failed to contact Riot API"});
  }
});
