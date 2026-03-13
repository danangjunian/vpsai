function unwrapMessage(message) {
  let msg = message || null;
  for (let i = 0; i < 8; i++) {
    if (!msg) break;
    if (msg.ephemeralMessage && msg.ephemeralMessage.message) {
      msg = msg.ephemeralMessage.message;
      continue;
    }
    if (msg.viewOnceMessage && msg.viewOnceMessage.message) {
      msg = msg.viewOnceMessage.message;
      continue;
    }
    if (msg.viewOnceMessageV2 && msg.viewOnceMessageV2.message) {
      msg = msg.viewOnceMessageV2.message;
      continue;
    }
    if (msg.viewOnceMessageV2Extension && msg.viewOnceMessageV2Extension.message) {
      msg = msg.viewOnceMessageV2Extension.message;
      continue;
    }
    break;
  }
  return msg || null;
}

function extractText(message) {
  const msg = unwrapMessage(message);
  if (!msg) return "";

  if (msg.conversation) return preserveText(msg.conversation);
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return preserveText(msg.extendedTextMessage.text);
  if (msg.imageMessage && msg.imageMessage.caption) return preserveText(msg.imageMessage.caption);
  if (msg.videoMessage && msg.videoMessage.caption) return preserveText(msg.videoMessage.caption);
  if (msg.documentMessage && msg.documentMessage.caption) return preserveText(msg.documentMessage.caption);

  if (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText) {
    return preserveText(msg.buttonsResponseMessage.selectedDisplayText);
  }
  if (msg.templateButtonReplyMessage && msg.templateButtonReplyMessage.selectedDisplayText) {
    return preserveText(msg.templateButtonReplyMessage.selectedDisplayText);
  }
  if (msg.listResponseMessage) {
    const title = preserveText(msg.listResponseMessage.title || "");
    if (title) return title;
    const rowId = preserveText(
      msg.listResponseMessage.singleSelectReply && msg.listResponseMessage.singleSelectReply.selectedRowId
        ? msg.listResponseMessage.singleSelectReply.selectedRowId
        : ""
    );
    if (rowId) return rowId;
  }

  return "";
}

function detectMedia(message) {
  const msg = unwrapMessage(message);
  if (!msg) return null;

  if (msg.imageMessage) {
    return {
      kind: "image",
      mimeType: String(msg.imageMessage.mimetype || "image/jpeg").trim() || "image/jpeg"
    };
  }

  if (msg.audioMessage) {
    return {
      kind: "audio",
      mimeType: String(msg.audioMessage.mimetype || "audio/ogg").trim() || "audio/ogg",
      isVoiceNote: Boolean(msg.audioMessage.ptt)
    };
  }

  return null;
}

function preserveText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r/g, "")
    .trim();
}

module.exports = {
  unwrapMessage,
  extractText,
  detectMedia
};
