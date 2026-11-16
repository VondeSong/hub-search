package com.craftsearch.desktop

import android.content.Context
import android.media.MediaRecorder
import android.os.SystemClock
import app.tauri.plugin.JSObject
import java.io.File

/** Foreground capture only. Finalized originals survive WebView reloads until explicitly acknowledged. */
internal object JournalVoiceRecorder {
    private var recorder: MediaRecorder? = null
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
        val next = MediaRecorder()
        try {
            next.setAudioSource(MediaRecorder.AudioSource.MIC)
            next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            next.setAudioChannels(1)
            next.setAudioSamplingRate(44100)
            next.setAudioEncodingBitRate(96000)
            next.setMaxFileSize(19L * 1024 * 1024)
            next.setOutputFile(output.absolutePath)
            next.prepare()
            next.start()
            recorder = next; elapsed = 0; paused = false; started = SystemClock.elapsedRealtime(); error = ""
            preferences(context).edit().putString("token", token).putLong("elapsed", 0).commit()
            next.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) { stop(context); error = "本段达到附件大小限制，已结束并保留原音。" } }
            next.setOnErrorListener { _, _, _ -> runCatching { stop(context) }; error = "录音意外中断，请回听核对已保存部分。" }
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
        try { current.stop(); preferences(context).edit().putLong("elapsed", elapsed).commit() }
        catch (e: RuntimeException) { error = "录音太短或音源中断，原文件保留供恢复。请返回后重试。" }
        finally { current.release(); recorder = null }
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
    @Synchronized fun acknowledge(context: Context, token: String): JSObject {
        check(recorder == null && token == preferences(context).getString("token", "")) { "录音身份已变化" }
        // Move rather than delete: keep the original recoverable if a caller's receipt is stale.
        file(context)?.let { source -> val saved = File(context.filesDir, "journal-voice/saved"); saved.mkdirs(); check(source.renameTo(File(saved, source.name))) { "原音整理失败，待保存状态已保留" } }
        preferences(context).edit().clear().commit(); error = ""
        return status(context)
    }
}
