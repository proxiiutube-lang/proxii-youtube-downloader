
const form = document.getElementById("url-form");
const urlInput = document.getElementById("video-url");
const message = document.getElementById("message");
const formatInput = document.getElementById("format");
const downloadButton = document.getElementById("download-button");
const downloadAgainButton = document.getElementById("download-again");

const initialUrl = new URLSearchParams(window.location.search).get("url");
if (initialUrl) {
  urlInput.value = initialUrl;
  message.textContent = "Video link added from the bookmarklet. Choose a format and download.";
}

let lastDownload = null;
const apiBaseUrl = window.location.protocol === "file:" ||
    window.location.port === "5500"
  ? "http://127.0.0.1:3000"
  : "";

async function downloadVideo(url, format) {
  downloadButton.disabled = true;
  downloadAgainButton.disabled = true;
  message.textContent = `Preparing your ${format.toUpperCase()} download...`;

  try {
    const response = await fetch(`${apiBaseUrl}/api/downloads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format }),
    });
    const responseText = await response.text();
    let result;

    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(
        "The downloader returned an unexpected response. Make sure the backend is running.",
      );
    }

    if (!response.ok) {
      if (response.status === 405) {
        throw new Error(
          "The downloader API is unavailable. Start the backend with `npm.cmd start` in the backend folder.",
        );
      }

      const serverMessage = result && typeof result === "object" &&
        typeof result.error === "string"
        ? result.error
        : `The server could not prepare this download (HTTP ${response.status}).`;
      throw new Error(serverMessage);
    }

    if (!result || typeof result !== "object" ||
        typeof result.downloadUrl !== "string" ||
        typeof result.filename !== "string") {
      throw new Error(
        "The downloader response is incomplete. Make sure the backend is running.",
      );
    }

    const link = document.createElement("a");
    link.href = new URL(result.downloadUrl, `${apiBaseUrl || window.location.origin}/`).href;
    link.download = result.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    lastDownload = { url, format };
    downloadAgainButton.hidden = false;
    message.textContent =
      `${format.toUpperCase()} download started. You can download it again below.`;
  } catch (error) {
    if (error instanceof TypeError) {
      message.textContent =
        "Cannot connect to the downloader. Start the backend with `npm.cmd start` in the backend folder.";
    } else {
      message.textContent = error instanceof Error
        ? error.message
        : "The download failed.";
    }
  } finally {
    downloadButton.disabled = false;
    downloadAgainButton.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();

  try {
    const parsedUrl = new URL(url);
    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
    ];

    if (parsedUrl.protocol !== "https:" ||
        !allowedHosts.includes(parsedUrl.hostname)) {
      throw new Error("Please enter a valid HTTPS YouTube video URL.");
    }

    await downloadVideo(url, formatInput.value);
  } catch (error) {
    message.textContent = error instanceof Error
      ? error.message
      : "Please enter a valid HTTPS YouTube video URL.";
  }
});

downloadAgainButton.addEventListener("click", async () => {
  if (lastDownload) {
    await downloadVideo(lastDownload.url, lastDownload.format);
  }
});
