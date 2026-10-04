const express = require("express");
const cors = require("cors");
const yts = require("yt-search");
const youtubedl = require("youtube-dl-exec");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const API_KEY = process.env.VORTEX_API_KEY || "";
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;

const DOWNLOAD_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =========================
   STATE
========================= */

let activeDownloads = 0;

const rateMap = new Map();

const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 20;

/* =========================
   HELPERS
========================= */

function removeFile(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {}
}

function cleanupPrefix(prefix) {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);

    for (const file of files) {
      if (file.startsWith(prefix)) {
        removeFile(path.join(DOWNLOAD_DIR, file));
      }
    }
  } catch {}
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();

    return (
      hostname === "youtube.com" ||
      hostname === "www.youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "youtu.be" ||
      hostname === "www.youtu.be"
    );
  } catch {
    return false;
  }
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  const entry = rateMap.get(ip);

  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, {
      start: now,
      count: 1
    });

    return next();
  }

  if (entry.count >= RATE_LIMIT) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please try again later."
    });
  }

  entry.count++;

  next();
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  const provided =
    req.headers["x-api-key"] ||
    req.query.api_key;

  if (!provided || provided !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Invalid or missing API key"
    });
  }

  next();
}

function acquireDownloadSlot(res) {
  if (activeDownloads >= MAX_CONCURRENT) {
    res.status(429).json({
      success: false,
      error: "Download server is busy. Please try again shortly."
    });

    return false;
  }

  activeDownloads++;
  return true;
}

function releaseDownloadSlot() {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

function sendFileAndCleanup(res, file, filename, contentType, prefix) {
  res.sendFile(
    file,
    {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition":
          `attachment; filename="${filename}"`
      }
    },
    err => {
      if (err) {
        console.error("SEND ERROR:", err.message);
      }

      cleanupPrefix(prefix);
    }
  );
}

function getQuality(value) {
  const allowed = ["360", "480", "720"];

  if (!value) {
    return "720";
  }

  return allowed.includes(String(value))
    ? String(value)
    : null;
}

function resolveSearchQuery(query) {
  return yts(query).then(result => {
    if (!result.videos || !result.videos.length) {
      throw new Error("No results found");
    }

    return result.videos[0].url;
  });
}

/* =========================
   GLOBAL MIDDLEWARE
========================= */

app.use(rateLimit);
app.use(requireApiKey);

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.json({
    name: "VORTEX MEDIA API",
    version: "4.0.0",
    status: "online",
    endpoints: {
      status: "/api/status",
      search: "/api/search?query=...",
      music: "/api/music?url=...",
      video: "/api/video?url=...&quality=720"
    }
  });
});

/* =========================
   STATUS
========================= */

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    status: "online",
    version: "4.0.0",
    service: "VORTEX MEDIA API",
    search: "ready",
    music: "ready",
    video: "ready",
    ffmpeg: "ready",
    activeDownloads,
    maxConcurrent: MAX_CONCURRENT,
    uptime: Math.floor(process.uptime())
  });
});

/* =========================
   SEARCH
========================= */

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Missing query"
      });
    }

    if (query.length > 200) {
      return res.status(400).json({
        success: false,
        error: "Query is too long"
      });
    }

    console.log("🔎 SEARCH:", query);

    const result = await yts(query);

    const videos = result.videos
      .slice(0, 10)
      .map(video => ({
        title: video.title,
        url: video.url,
        duration: video.timestamp,
        seconds: video.seconds,
        views: video.views,
        author: video.author?.name || null,
        thumbnail: video.thumbnail
      }));

    res.json({
      success: true,
      query,
      results: videos
    });

  } catch (error) {
    console.error("SEARCH ERROR:", error.message);

    res.status(500).json({
      success: false,
      error: "Search failed"
    });
  }
});

/* =========================
   MUSIC
========================= */

app.get("/api/music", async (req, res) => {
  if (!acquireDownloadSlot(res)) {
    return;
  }

  const id = Date.now();
  const prefix = `audio-${id}`;

  const template = path.join(
    DOWNLOAD_DIR,
    `${prefix}.%(ext)s`
  );

  try {
    let url = String(req.query.url || "").trim();

    const query = String(req.query.query || "").trim();

    if (!url && query) {
      console.log("🎵 SEARCH MUSIC:", query);
      url = await resolveSearchQuery(query);
    }

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "Missing url or query"
      });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Invalid URL"
      });
    }

    if (!isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Only YouTube URLs are supported"
      });
    }

    console.log("🎵 MUSIC:", url);

    await youtubedl(url, {
      jsRuntimes: "deno",

      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: "0",

      output: template,

      noPlaylist: true
    });

    const output = path.join(
      DOWNLOAD_DIR,
      `${prefix}.mp3`
    );

    if (!fs.existsSync(output)) {
      throw new Error("Audio file was not created");
    }

    console.log("✔ MUSIC READY:", output);

    sendFileAndCleanup(
      res,
      output,
      "vortex-audio.mp3",
      "audio/mpeg",
      prefix
    );

  } catch (error) {
    console.error("MUSIC ERROR:", error.message);

    cleanupPrefix(prefix);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Music download failed"
      });
    }

  } finally {
    releaseDownloadSlot();
  }
});

/* =========================
   VIDEO
========================= */

app.get("/api/video", async (req, res) => {
  if (!acquireDownloadSlot(res)) {
    return;
  }

  const id = Date.now();
  const prefix = `video-${id}`;

  const quality = getQuality(req.query.quality);

  if (!quality) {
    releaseDownloadSlot();

    return res.status(400).json({
      success: false,
      error: "Invalid quality. Use 360, 480, or 720."
    });
  }

  const template = path.join(
    DOWNLOAD_DIR,
    `${prefix}.%(ext)s`
  );

  const finalFile = path.join(
    DOWNLOAD_DIR,
    `${prefix}.mp4`
  );

  try {
    let url = String(req.query.url || "").trim();

    const query = String(req.query.query || "").trim();

    if (!url && query) {
      console.log("🎬 SEARCH VIDEO:", query);
      url = await resolveSearchQuery(query);
    }

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "Missing url or query"
      });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Invalid URL"
      });
    }

    if (!isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Only YouTube URLs are supported"
      });
    }

    console.log(`🎬 VIDEO ${quality}p:`, url);

    await youtubedl(url, {
      jsRuntimes: "deno",

      format:
        `bv*[ext=mp4][height<=${quality}]+ba[ext=m4a]/` +
        `bv*[height<=${quality}]+ba/` +
        `b[ext=mp4][height<=${quality}]/` +
        `b[height<=${quality}]`,

      mergeOutputFormat: "mp4",

      output: template,

      noPlaylist: true
    });

    let output = finalFile;

    /*
     * Find merged MP4 if yt-dlp selected
     * a slightly different filename.
     */

    if (!fs.existsSync(output)) {
      const files = fs.readdirSync(DOWNLOAD_DIR);

      const merged = files.find(file =>
        file.startsWith(`${prefix}.`) &&
        file.endsWith(".mp4") &&
        !file.includes(".f")
      );

      if (merged) {
        output = path.join(DOWNLOAD_DIR, merged);
      }
    }

    /*
     * Manual FFmpeg fallback.
     */

    if (!fs.existsSync(output)) {
      const files = fs.readdirSync(DOWNLOAD_DIR);

      const video = files.find(file =>
        file.startsWith(`${prefix}.`) &&
        file.endsWith(".mp4")
      );

      const audio = files.find(file =>
        file.startsWith(`${prefix}.`) &&
        file.endsWith(".m4a")
      );

      if (!video || !audio) {
        throw new Error(
          "Downloaded streams found, but video/audio merge files are missing"
        );
      }

      const videoFile = path.join(
        DOWNLOAD_DIR,
        video
      );

      const audioFile = path.join(
        DOWNLOAD_DIR,
        audio
      );

      console.log("🔧 Merging video + audio with FFmpeg...");

      await new Promise((resolve, reject) => {
        const ffmpeg = spawn(
          "ffmpeg",
          [
            "-y",
            "-i", videoFile,
            "-i", audioFile,
            "-c:v", "copy",
            "-c:a", "aac",
            "-movflags", "+faststart",
            output
          ],
          {
            stdio: "inherit"
          }
        );

        ffmpeg.on("error", reject);

        ffmpeg.on("close", code => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(`FFmpeg exited with code ${code}`)
            );
          }
        });
      });

      if (!fs.existsSync(output)) {
        throw new Error(
          "FFmpeg failed to create the final video"
        );
      }
    }

    console.log("✔ VIDEO READY:", output);

    sendFileAndCleanup(
      res,
      output,
      `vortex-video-${quality}p.mp4`,
      "video/mp4",
      prefix
    );

  } catch (error) {
    console.error("VIDEO ERROR:", error.message);

    cleanupPrefix(prefix);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Video download failed"
      });
    }

  } finally {
    releaseDownloadSlot();
  }
});

/* =========================
   404
========================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
});

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: "Internal server error"
  });
});

/* =========================
   START
========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║       VORTEX MEDIA API v4.0.0       ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");
  console.log(`🚀 Server: http://0.0.0.0:${PORT}`);
  console.log(`📁 Downloads: ${DOWNLOAD_DIR}`);
  console.log(`⚡ Max downloads: ${MAX_CONCURRENT}`);
  console.log(`🔐 API key: ${API_KEY ? "enabled" : "disabled"}`);
  console.log("");
  console.log("✔ Search ready");
  console.log("✔ Music ready");
  console.log("✔ Video ready");
  console.log("✔ FFmpeg ready");
  console.log("✔ Deno/yt-dlp ready");
  console.log("");
});
