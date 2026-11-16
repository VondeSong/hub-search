package com.craftsearch.desktop

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import java.io.File

/** A single microphone feeds the AAC original and a bounded, seekable PCM transcription source. */
internal class JournalPcmCapture(private val output: File, private val ended: (Boolean) -> Unit) {
    companion object { const val RATE = 24000 }
    private var source: AudioRecord? = null
    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    @Volatile private var paused = false
    @Volatile private var failure = false

    fun start() {
        val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "本机暂不支持 24 kHz 录音" }
        try {
            source = AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, RATE * 2))
            check(source!!.state == AudioRecord.STATE_INITIALIZED) { "麦克风初始化失败" }
            codec = MediaCodec.createEncoderByType("audio/mp4a-latm")
            val format = MediaFormat.createAudioFormat("audio/mp4a-latm", RATE, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 96000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4096)
            }
            codec!!.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec!!.start()
            muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            source!!.startRecording()
            check(source!!.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "麦克风未能开始录音" }
            running = true
            thread = Thread({ capture() }, "journal-voice-encode").apply { start() }
        } catch (e: Exception) { release(); throw e }
    }
    fun pause() { paused = true }
    fun resume() { paused = false }
    fun stop() {
        running = false
        runCatching { source?.stop() }
        thread?.join(9000)
        check(thread?.isAlive != true) { "原音仍在封装，请稍后重试" }
        check(!failure) { "录音意外中断，原音保留供核对" }
    }
    fun release() {
        if (thread?.isAlive == true) return
        runCatching { source?.stop() }; source?.release(); source = null
        runCatching { codec?.stop() }; codec?.release(); codec = null
        muxer?.release(); muxer = null
    }
    private fun capture() {
        val encoder = codec!!
        val sink = muxer!!
        var track = -1
        var bytes = 0L
        val info = MediaCodec.BufferInfo()
        fun drain(end: Boolean) {
            val deadline = System.nanoTime() + 5_000_000_000L
            while (true) {
                val index = encoder.dequeueOutputBuffer(info, if (end) 10_000 else 0)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    check(track < 0); track = sink.addTrack(encoder.outputFormat); sink.start()
                } else if (index >= 0) {
                    if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                        check(track >= 0)
                        val buffer = encoder.getOutputBuffer(index)!!
                        buffer.position(info.offset); buffer.limit(info.offset + info.size)
                        sink.writeSampleData(track, buffer, info)
                    }
                    val finished = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    encoder.releaseOutputBuffer(index, false)
                    if (finished) return
                } else if (!end) return
                check(!end || System.nanoTime() < deadline) { "录音封装超时" }
            }
        }
        fun encode(buffer: ByteArray, count: Int, end: Boolean = false) {
            val deadline = System.nanoTime() + 3_000_000_000L
            var index: Int
            while (true) {
                index = encoder.dequeueInputBuffer(10_000)
                if (index >= 0) break
                drain(false)
                check(System.nanoTime() < deadline) { "录音编码超时" }
            }
            encoder.getInputBuffer(index)!!.apply { clear(); put(buffer, 0, count) }
            encoder.queueInputBuffer(index, 0, count, bytes * 1_000_000 / (RATE * 2), if (end) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
            drain(end)
        }
        var reachedLimit = false
        try {
            File(output.parentFile, output.nameWithoutExtension + ".pcm").outputStream().use { pcm ->
                val buffer = ByteArray(2048)
                while (running) {
                    if (paused) { Thread.sleep(15); continue }
                    val count = source!!.read(buffer, 0, buffer.size)
                    if (!running) break
                    check(count > 0) { "麦克风音源中断" }
                    if (paused) continue
                    encode(buffer, count)
                    pcm.write(buffer, 0, count); bytes += count
                    if (bytes >= RATE * 2L * 30 * 60 || output.length() >= 19L * 1024 * 1024) { reachedLimit = true; running = false }
                }
                pcm.flush()
                encode(buffer, 0, true)
            }
        } catch (_: Exception) { failure = true }
        finally {
            running = false
            if (track >= 0) runCatching { sink.stop() }.onFailure { failure = true }
            runCatching { source?.stop() }; source?.release(); source = null
            runCatching { encoder.stop() }; encoder.release(); codec = null
            sink.release(); muxer = null
            if (reachedLimit || failure) ended(failure)
        }
    }
}
