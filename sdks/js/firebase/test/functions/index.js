const { onCall, HttpsError } = require("firebase-functions/v2/https");

exports.echo = onCall(() => {
  return { ok: true };
});

exports.fail = onCall(() => {
  throw new HttpsError("unavailable", "nope");
});
