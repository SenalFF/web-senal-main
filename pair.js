import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { upload } from "./mega.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

// Wait until the WebSocket is fully open (readyState === 1)
function waitForSocketOpen(sock, timeoutMs = 15000) {
    return new Promise((resolve) => {
        if (sock.ws?.readyState === 1) return resolve();
        const interval = setInterval(() => {
            if (sock.ws?.readyState === 1) {
                clearInterval(interval);
                resolve();
            }
        }, 300);
        setTimeout(() => {
            clearInterval(interval);
            resolve(); // resolve anyway to avoid hanging
        }, timeoutMs);
    });
}

router.get("/", async (req, res) => {
    let num = req.query.number;
    let dirs = "./" + (num || `session`);

    removeFile(dirs);

    num = num.replace(/[^0-9]/g, "");

    const phone = pn("+" + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({
                code: "Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 94769872326 for LK, etc.) without + or spaces.",
            });
        }
        return;
    }
    num = phone.getNumber("e164").replace("+", "");

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();

            let KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: ["Windows", "Chrome", "120.0.0"], // ✅ Fixed: Browsers.windows() removed in Baileys 7.x
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === "open") {
                    console.log("✅ Connected successfully!");
                    console.log("📱 Uploading session to MEGA...");

                    try {
                        const credsPath = dirs + "/creds.json";
                        const megaUrl = await upload(
                            credsPath,
                            `creds_${num}_${Date.now()}.json`,
                        );
                        const megaFileId = getMegaFileId(megaUrl);

                        if (megaFileId) {
                            console.log("✅ Session uploaded to MEGA. File ID:", megaFileId);
                            const userJid = jidNormalizedUser(num + "@s.whatsapp.net");
                            await KnightBot.sendMessage(userJid, {
                                text: `${megaFileId}`,
                            });
                            console.log("📄 MEGA file ID sent successfully");
                        } else {
                            console.log("❌ Failed to extract MEGA file ID");
                        }

                        console.log("🧹 Cleaning up session...");
                        await delay(1000);
                        removeFile(dirs);
                        console.log("✅ Session cleaned up successfully");
                        console.log("🎉 Process completed successfully!");

                        await delay(2000);
                        process.exit(0);
                    } catch (error) {
                        console.error("❌ Error uploading to MEGA:", error);
                        removeFile(dirs);
                        await delay(2000);
                        process.exit(1);
                    }
                }

                if (isNewLogin) console.log("🔐 New login via pair code");
                if (isOnline) console.log("📶 Client is online");

                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    // If response already sent (pairing code delivered), don't restart
                    if (res.headersSent) {
                        console.log("ℹ️ Connection closed after pairing code sent — ignoring.");
                        return;
                    }

                    if (statusCode === 401 || statusCode === 428) {
                        console.log(`❌ Auth error (${statusCode}). Not reconnecting.`);
                        if (!res.headersSent) {
                            res.status(503).send({ code: "Auth failed. Please try again." });
                        }
                        setTimeout(() => process.exit(1), 2000);
                    } else {
                        console.log(`🔁 Connection closed (${statusCode}) — restarting...`);
                        initiateSession();
                    }
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            if (!KnightBot.authState.creds.registered) {
                // ✅ Wait for WebSocket to be fully open before requesting pairing code
                await waitForSocketOpen(KnightBot, 15000);
                await delay(2000);

                num = num.replace(/[^\d]/g, "");

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        res.send({ code });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!res.headersSent) {
                        res.status(503).send({
                            code: "Failed to get pairing code. Please check your number and try again.",
                        });
                    }
                    setTimeout(() => process.exit(1), 2000);
                }
            }

        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            setTimeout(() => process.exit(1), 2000);
        }
    }

    await initiateSession();
});

process.on("uncaughtException", (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("statusCode: 515") || e.includes("statusCode: 503")) return;
    console.log("Caught exception: ", err);
    process.exit(1);
});

export default router;
