const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const cred = require("./madwebrtc-firebase.json");
require("dotenv").config();

if (!getApps().length) {
  initializeApp({
    credential: cert(cred),
    databaseURL: "https://madwebrtc-default-rtdb.firebaseio.com",
  });
}

const db = getDatabase();
module.exports = { db };