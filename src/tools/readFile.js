// src/tools/readFile.js
const fs = require('fs');
const path = require('path');
const { PLATFORM_DISCORD } = require('../config/constants');
const { extractTextFromPdfBuffer, mediaToContentPart } = require('../utils/media');
const { isPathAllowed, ensureUserSkeleton, resolveStorageId } = require('../utils/userPaths');

const MAX_TEXT_BYTES = 50 * 1024; // 50KB limit for text reading
const MAX_IMAGE_READS = 10;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // 15MB limit for audio

/**
 * Read file tool execution logic.
 * On Discord, paths are implicitly relative to history/. On WhatsApp paths
 * are relative to the user root and may target history/, permanent/,
 * searched_images/, projects/**, or the special skills: prefix.
 */
async function readFileTool(filePath, userCtx, responseCtx) {
  if (responseCtx.imagesReadCount === undefined) responseCtx.imagesReadCount = 0;

  if (!resolveStorageId(userCtx)) {
    return JSON.stringify({ success: false, error: 'Could not resolve storage ID for this context.' });
  }

  ensureUserSkeleton(userCtx);

  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  // On Discord, allow both "file.pdf" and "history/file.pdf" by normalizing.
  let rawPath = (filePath || '').trim();
  if (isDiscord) {
    if (rawPath.startsWith('./')) rawPath = rawPath.slice(2);
    if (rawPath.startsWith('/')) rawPath = rawPath.replace(/^\/+/, '');
    if (!rawPath.startsWith('history/') && !rawPath.startsWith('skills:') && !rawPath.startsWith('skills/')) {
      rawPath = 'history/' + rawPath;
    }
  }

  const check = isPathAllowed(userCtx, rawPath, { op: 'read' });
  if (!check.ok) {
    return JSON.stringify({ success: false, error: `Access denied: ${check.reason}` });
  }

  const absolutePath = check.absPath;
  const displayPath = rawPath;

  if (!fs.existsSync(absolutePath)) {
    return JSON.stringify({ success: false, error: `File not found at path "${displayPath}".` });
  }

  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (err) {
    if (err.code === 'EACCES') {
      return JSON.stringify({ success: false, error: `Access denied to file "${displayPath}".` });
    }
    return JSON.stringify({ success: false, error: `Cannot read file "${displayPath}": ${err.message}` });
  }

  if (stat.isDirectory()) {
    return JSON.stringify({ success: false, error: `Path is a directory, not a file.` });
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const sanitizedPath = displayPath;

  // ── Size check before reading into memory ──
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    // Image size usually not a problem for memory but we check count later
  } else if (['.ogg', '.mp3', '.wav', '.m4a'].includes(ext)) {
    if (stat.size > MAX_AUDIO_BYTES) {
      const maxMins = Math.round(MAX_AUDIO_BYTES / (16 * 1024 * 60));
      return JSON.stringify({ success: false, error: `Audio file exceeds size limit (max ~${maxMins} minutes).` });
    }
  } else if (stat.size > MAX_TEXT_BYTES * 4 && ext !== '.pdf') {
    // Heuristic: don't read more than 4x max text into memory if it's just text
    return JSON.stringify({ success: false, error: `File is too large to read as text (max ${MAX_TEXT_BYTES / 1024}KB).` });
  }

  const buffer = fs.readFileSync(absolutePath);

  // ── Images ──
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    if (responseCtx.imagesReadCount >= MAX_IMAGE_READS) {
      return JSON.stringify({ success: false, error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.` });
    }
    responseCtx.imagesReadCount++;
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    return [
      { type: 'text', text: `Contents of ${sanitizedPath}:` },
      mediaToContentPart(buffer, mimeMap[ext])
    ];
  }

  // ── Audio ──
  if (['.ogg', '.mp3', '.wav', '.m4a'].includes(ext)) {
    const mimeMap = { '.ogg': 'audio/ogg', '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/m4a' };
    return [
      { type: 'text', text: `Audio contents of ${sanitizedPath}:` },
      mediaToContentPart(buffer, mimeMap[ext])
    ];
  }

  // ── PDF ──
  if (ext === '.pdf') {
    const info = await extractTextFromPdfBuffer(buffer);
    if (!info.success) {
      return JSON.stringify({ success: false, error: `Failed to extract text from PDF.` });
    }
    let text = info.text;
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      text = Buffer.from(text).slice(0, MAX_TEXT_BYTES).toString('utf-8') + '\n\n[File truncated, too long]';
    }
    return `File: ${sanitizedPath}\n\n<Transcription>\n${text}\n</Transcription>`;
  }

  // ── Text/Code ──
  let text = buffer.toString('utf-8');
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    // Correct byte-based truncation
    const truncatedBuffer = buffer.slice(0, MAX_TEXT_BYTES);
    text = truncatedBuffer.toString('utf-8') + '\n\n[File truncated, too long]';
  }

  // Refresh timestamp
  const now = new Date();
  try {
    fs.utimesSync(absolutePath, now, now);
  } catch (err) { }

  return `File: ${sanitizedPath}\n\n${text}`;
}

module.exports = { readFileTool };
