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
    if (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message) {
      msg = msg.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }
  return msg || null;
}

function extractText(message) {
  const msg = unwrapMessage(message);
  if (!msg) return "";

  if (msg.conversation) return preserveText_(msg.conversation);
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return preserveText_(msg.extendedTextMessage.text);
  if (msg.imageMessage && msg.imageMessage.caption) return preserveText_(msg.imageMessage.caption);
  if (msg.videoMessage && msg.videoMessage.caption) return preserveText_(msg.videoMessage.caption);
  if (msg.documentMessage && msg.documentMessage.caption) return preserveText_(msg.documentMessage.caption);

  if (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText) {
    return preserveText_(msg.buttonsResponseMessage.selectedDisplayText);
  }

  if (msg.templateButtonReplyMessage && msg.templateButtonReplyMessage.selectedDisplayText) {
    return preserveText_(msg.templateButtonReplyMessage.selectedDisplayText);
  }

  if (msg.listResponseMessage) {
    const title = preserveText_(msg.listResponseMessage.title || "");
    if (title) return title;
    const rowId = preserveText_(
      msg.listResponseMessage.singleSelectReply && msg.listResponseMessage.singleSelectReply.selectedRowId
        ? msg.listResponseMessage.singleSelectReply.selectedRowId
        : ""
    );
    if (rowId) return rowId;
  }

  return "";
}

function preserveText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r/g, "")
    .trim();
}

module.exports = {
  extractText
};
