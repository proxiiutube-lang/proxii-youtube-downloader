const express = require("express");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const app = express();
const port = Number(process.env.PORT) || 3000;
const frontendDirectory = path.resolve(__dirname, "..", "frontend");
const downloads = new Map();
const downloadLifetime = 15 * 60 * 1000;
const liveServerOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && liveServerOrigins.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
  }

  next();
});
app.use(express.json({ limit: "10kb" }));
app.use(express.static(frontendDirectory));

app.get("/healthz", (req, res) => {
  res.json({ status: "ok" });
});

function validateRequest(body) {
  if (!body || typeof body.url !== "string" ||
      !["mp3", "mp4"].includes(body.format)) {
    return "Provide a YouTube URL and choose MP3 or MP4.";
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(body.url);
  } catch {
    return "Enter a valid YouTube video URL.";
  }

  const allowedHosts = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
  ]);

  if (parsedUrl.protocol !== "https:" ||
      !allowedHosts.has(parsedUrl.hostname) ||
      parsedUrl.username ||
      parsedUrl.password) {
    return "Enter a valid HTTPS YouTube video URL.";
  }

  return null;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const process = spawn("yt-dlp", args, { windowsHide: true });
    let errorOutput = "";

    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => {
      errorOutput = (errorOutput + chunk).slice(-8000);
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(errorOutput.trim() || "yt-dlp could not download this video."));
      }
    });
  });
}

async function removeDownload(token) {
  const download = downloads.get(token);
  if (!download) {
    return;
  }

  downloads.delete(token);
  clearTimeout(download.expiryTimer);
  await fs.rm(download.directory, { recursive: true, force: true });
}

app.post("/api/downloads", async (req, res) => {
  const validationError = validateRequest(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxii-download-"));
    const outputTemplate = path.join(directory, "download.%(ext)s");
    const args = [
      "--no-playlist",
      "--no-progress",
      "--output",
      outputTemplate,
    ];

    if (req.body.format === "mp3") {
      args.push("--extract-audio", "--audio-format", "mp3");
    } else {
      args.push(
        "--format",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "--recode-video",
        "mp4",
      );
    }
    args.push("--", req.body.url);

    await runYtDlp(args);
    const outputFiles = (await fs.readdir(directory))
      .filter((file) => file.startsWith("download."));

    if (outputFiles.length !== 1) {
      throw new Error("The downloader did not produce the expected output file.");
    }

    const token = randomUUID();
    const filePath = path.join(directory, outputFiles[0]);
    const download = {
      directory,
      filePath,
      filename: `youtube-video.${req.body.format}`,
      expiryTimer: setTimeout(() => {
        removeDownload(token).catch((error) => {
          console.error("Failed to clean up a temporary download:", error);
        });
      }, downloadLifetime),
    };
    download.expiryTimer.unref();
    downloads.set(token, download);

    res.json({
      downloadUrl: `/api/downloads/${token}`,
      filename: download.filename,
    });
  } catch (error) {
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true }).catch((cleanupError) => {
        console.error("Failed to clean up a temporary download:", cleanupError);
      });
    }

    if (error.code === "ENOENT") {
      res.status(503).json({
        error: "yt-dlp is not installed or is not available on the server PATH.",
      });
      return;
    }

    console.error("YouTube download failed:", error.message);
    res.status(502).json({
      error: error.message || "The video could not be downloaded.",
    });
  }
});

app.get("/api/downloads/:token", (req, res) => {
  const download = downloads.get(req.params.token);
  if (!download) {
    res.status(404).send("This prepared download has expired. Please try again.");
    return;
  }

  res.download(download.filePath, download.filename, (error) => {
    removeDownload(req.params.token).catch((cleanupError) => {
      console.error("Failed to clean up a temporary download:", cleanupError);
    });

    if (error && !res.headersSent) {
      res.status(500).send("The prepared file could not be sent.");
    } else if (error) {
      res.destroy(error);
    }
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "The requested download endpoint was not found." });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let status = 500;
  let message = "An unexpected server error occurred.";
  if (error.type === "entity.parse.failed") {
    status = 400;
    message = "The request could not be read. Please try again.";
  } else if (error.type === "entity.too.large") {
    status = 413;
    message = "The request is too large.";
  } else {
    console.error("Downloader server error:", error);
  }

  res.status(status).json({
    error: message,
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Proxii downloader is running at http://127.0.0.1:${port}`);
});