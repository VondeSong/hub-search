package com.craftsearch.desktop

import android.content.Context
import android.os.SystemClock
import app.tauri.plugin.JSObject
import java.io.File

/** Foreground capture only. Finalized originals survive WebView reloads until explicitly acknowledged. */
internal object JournalVoiceRecorder {
    private var recorder: JournalPcmCapture? = null
    private var elapsed = 0L
    private var started = 0L
    private var paused = false
    private var error = ""
    private fun preferences(context: Context) = context.getSharedPreferences("journal-voice", Context.MODE_PRIVATE)
    private fun file(context: Context): File? {
        val token = preferences(context).getString("token", "") ?: ""
        if (!token.matches(Regex("[a-f0-9]{32}"))) return null
        return File(context.filesDir, "journal-voice/$token.m4a")
    }
    @Synchronized fun status(context: Context): JSObject {
        val prefs = preferences(context)
        val pending = file(context)
        return JSObject().put("state", if (recorder != null) { if (paused) "paused" else "recording" } else if (pending?.isFile == true) "ready" else "idle")
            .put("token", prefs.getString("token", ""))
            .put("elapsed", if (recorder != null) elapsed + if (paused) 0 else SystemClock.elapsedRealtime() - started else prefs.getLong("elapsed", 0))
            .put("error", error)
    }
    @Suppress("DEPRECATION")
    @Synchronized fun start(context: Context): JSObject {
        check(recorder == null && file(context)?.exists() != true) { "请先保存上一段录音，原音仍保留" }
        val token = java.util.UUID.randomUUID().toString().replace("-", "")
        val output = File(context.filesDir, "journal-voice/$token.m4a")
        output.parentFile!!.mkdirs()
        val next = JournalPcmCapture(output) { failed ->
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                runCatching { stop(context) }
                error = if (failed) "录音意外中断，请回听核对已保存部分。" else "本段达到录音限制，已结束并保留原音。"
            }
        }
        try {
            next.start()
            recorder = next; elapsed = 0; paused = false; started = SystemClock.elapsedRealtime(); error = ""
            preferences(context).edit().putString("token", token).putLong("elapsed", 0).commit()
            return status(context)
        } catch (e: Exception) { next.release(); output.delete(); throw e }
    }
    @Synchronized fun pause(context: Context): JSObject {
        val current = recorder ?: error("当前没有录音")
        if (!paused) { current.pause(); elapsed += SystemClock.elapsedRealtime() - started; paused = true }
        return status(context)
    }
    @Synchronized fun resume(context: Context): JSObject {
        val current = recorder ?: error("当前没有录音")
        if (paused) { current.resume(); started = SystemClock.elapsedRealtime(); paused = false }
        return status(context)
    }
    @Synchronized fun stop(context: Context): JSObject {
        val current = recorder ?: return status(context)
        if (!paused) elapsed += SystemClock.elapsedRealtime() - started
        try { current.stop() }
        catch (e: RuntimeException) { error = "录音太短或音源中断，原文件保留供恢复。请返回后重试。" }
        finally { preferences(context).edit().putLong("elapsed", elapsed).commit(); current.release(); recorder = null }
        return status(context)
    }
    @Synchronized fun read(context: Context, token: String): JSObject {
        check(recorder == null) { "请先结束录音" }
        check(token == preferences(context).getString("token", "")) { "录音身份已变化" }
        val source = file(context) ?: error("没有待保存原音")
        check(source.length() in 1..(20L * 1024 * 1024)) { "原音为空或超过附件限制" }
        val media = android.media.MediaMetadataRetriever()
        try { media.setDataSource(source.absolutePath); check((media.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0) > 0) { "原音未完成封装，暂不能保存为有效录音" } }
        finally { media.release() }
        return JSObject().put("content", android.util.Base64.encodeToString(source.readBytes(), android.util.Base64.NO_WRAP))
            .put("name", "语音-${preferences(context).getLong("elapsed", 0) / 1000}秒.m4a")
    }
    @Synchronized fun chunk(context: Context, token: String, offset: Long): JSObject {
        check(token.matches(Regex("[a-f0-9]{32}")) && offset >= 0 && offset % 2 == 0L) { "录音分段身份无效" }
        var source = File(context.filesDir, "journal-voice/$token.pcm")
        if (!source.isFile) source = File(context.filesDir, "journal-voice/saved/$token.pcm")
        check(source.isFile) { "这段原音没有实时分段，请使用补转写" }
        val total = source.length() / 2 * 2
        check(offset <= total) { "分段进度超出原音范围" }
        val bytes = ByteArray(minOf(total - offset, 48000).toInt())
        java.io.RandomAccessFile(source, "r").use { it.seek(offset); it.readFully(bytes) }
        return JSObject().put("audio", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
            .put("offset", offset).put("next", offset + bytes.size).put("total", total)
            .put("closed", recorder == null || token != preferences(context).getString("token", "")).put("sampleRate", JournalPcmCapture.RATE)
    }
    @Synchronized fun releaseChunks(context: Context, token: String): JSObject {
        check(token.matches(Regex("[a-f0-9]{32}"))) { "录音身份无效" }
        check(recorder == null || token != preferences(context).getString("token", "")) { "正在录音，暂不清理分段" }
        val folder = File(context.filesDir, "journal-voice/saved")
        check(File(folder, "$token.m4a").length() > 0) { "请先保留原音" }
        val media = android.media.MediaMetadataRetriever()
        try {
            media.setDataSource(File(folder, "$token.m4a").absolutePath)
            check((media.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0) > 0) { "原音需要核对，保留 PCM 以便恢复" }
        } finally { media.release() }
        val pcm = File(folder, "$token.pcm")
        check(!pcm.exists() || pcm.delete()) { "临时分段清理未完成，压缩原音仍保留" }
        return JSObject().put("released", true)
    }
    @Synchronized fun acknowledge(context: Context, token: String): JSObject {
        check(recorder == null && token == preferences(context).getString("token", "")) { "录音身份已变化" }
        // Move rather than delete: keep the original recoverable if a caller's receipt is stale.
        file(context)?.let { source ->
            val saved = File(context.filesDir, "journal-voice/saved"); saved.mkdirs()
            check(source.renameTo(File(saved, source.name))) { "原音整理失败，待保存状态已保留" }
            val pcm = File(source.parentFile, "$token.pcm")
            if (pcm.exists()) check(pcm.renameTo(File(saved, pcm.name))) { "转写分段整理失败，原音仍保留" }
        }
        preferences(context).edit().clear().commit(); error = ""
        return status(context)
    }
}
