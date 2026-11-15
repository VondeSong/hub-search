package com.craftsearch.desktop

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import app.tauri.plugin.JSObject
import androidx.core.net.toUri
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.Closeable

@InvokeArg
class SourceOpenArgs { lateinit var url: String }

@InvokeArg
class QuickJournalScheduleArgs { lateinit var root: String }

@InvokeArg
class JournalShareArgs { lateinit var text: String }

@InvokeArg
class FlashcardBackupReadArgs { lateinit var uri: String; lateinit var destination: String; lateinit var operationId: String }

@InvokeArg
class FlashcardBackupCancelArgs { lateinit var operationId: String }

@InvokeArg
class PreparedAttachmentExportArgs { lateinit var token: String }

@InvokeArg
class QualityDocumentArgs { lateinit var uri: String; lateinit var content: String }

@InvokeArg
class QualityDocumentExportArgs { lateinit var content: String }

@InvokeArg
class AttachmentExportArgs {
    lateinit var sourcePath: String
    lateinit var hash: String
    lateinit var fileName: String
    lateinit var mimeType: String
    var operationId: String? = null
}

/** Only the accepted copy owns these streams. Cancellation never takes a
 * database lock and closes provider streams off the Android UI thread. */
internal object BackupCopyControl {
    internal class Token {
        private var cancelled = false
        private var committed = false
        private val streams = mutableSetOf<Closeable>()
        @Synchronized fun checkpoint() { check(!cancelled) { "BACKUP_CANCELLED:备份操作已取消" } }
        @Synchronized fun terminal() = cancelled || committed
        fun <T : Closeable, R> use(stream: T, action: (T) -> R): R {
            return stream.use { owned ->
                synchronized(this) { checkpoint(); streams.add(owned) }
                try { action(owned) }
                finally { synchronized(this) { streams.remove(owned) } }
            }
        }
        @Synchronized fun <T> commit(action: () -> T): T {
            checkpoint()
            val result = action()
            committed = true
            return result
        }
        fun cancel(): Boolean {
            val closing = synchronized(this) {
                if (committed) return false
                cancelled = true
                streams.toList()
            }
            closing.forEach { runCatching { it.close() } }
            return true
        }
    }
    private data class Entry(val token: Token, var active: Boolean, val createdAt: Long)
    private val entries = linkedMapOf<String, Entry>()
    private fun valid(id: String) = require(id.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "备份操作标识无效" }
    @Synchronized fun begin(id: String): Token {
        valid(id)
        prune()
        val previous = entries[id]
        require(previous?.active != true) { "备份操作已在执行" }
        require(entries.values.count { it.active } < 4) { "备份复制达到并发上限" }
        val entry = previous ?: Entry(Token(), false, System.currentTimeMillis())
        entry.token.checkpoint()
        require(!entry.token.terminal()) { "备份操作已完成" }
        entry.active = true
        entries[id] = entry
        return entry.token
    }
    @Synchronized fun finish(id: String, token: Token) {
        if (entries[id]?.token === token) {
            // Keep the terminal receipt briefly: a stop that began before
            // completion must not replace a completed durable job record.
            if (token.terminal()) entries[id]?.active = false else entries.remove(id)
        }
    }
    fun cancel(id: String): Boolean {
        val token = synchronized(this) {
            valid(id); prune()
            // Retain an early stop briefly so admission cannot race past it.
            entries.getOrPut(id) { Entry(Token(), false, System.currentTimeMillis()) }.token
        }
        return token.cancel()
    }
    private fun prune() {
        val cutoff = System.currentTimeMillis() - 60_000
        entries.entries.removeAll { !it.value.active && it.value.createdAt < cutoff }
        while (entries.size >= 64) {
            val oldest = entries.entries.firstOrNull { !it.value.active } ?: break
            entries.remove(oldest.key)
        }
    }
}

@TauriPlugin
class SourceOpenerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun focusJournalEditor(invoke: Invoke) {
        activity.runOnUiThread {
            (activity as? MainActivity)?.requestJournalKeyboard { invoke.resolve() } ?: invoke.resolve()
        }
    }
    @Command
    fun consumeJournalAction(invoke: Invoke) {
        val state = activity.getSharedPreferences("journal-entry", Context.MODE_PRIVATE)
        val action = state.getString("action", "") ?: ""
        val record = state.getString("recordId", "") ?: ""
        if (action.isNotEmpty()) state.edit().clear().commit()
        invoke.resolve(JSObject().put("action", action).put("recordId", record))
    }
    @Command
    fun shareJournal(invoke: Invoke) {
        try {
            val text = invoke.parseArgs(JournalShareArgs::class.java).text
            require(text.toByteArray(Charsets.UTF_8).size <= 100000)
            activity.runOnUiThread {
                try {
                    activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "分享记录"))
                    invoke.resolve()
                } catch (e: Exception) { invoke.reject("系统分享未打开，原记录保留") }
            }
        } catch (e: Exception) { invoke.reject("分享内容无效，原记录保留") }
    }
    @Command
    fun requestJournalTile(invoke: Invoke) {
        if (android.os.Build.VERSION.SDK_INT < 33) {
            invoke.resolve(JSObject().put("status", "请下拉控制中心，点编辑，将 Hub「记一条」拖到常用区域。"))
            return
        }
        activity.runOnUiThread {
            try {
                val manager = activity.getSystemService(android.app.StatusBarManager::class.java)
                manager.requestAddTileService(android.content.ComponentName(activity, JournalTileService::class.java), "记一条", android.graphics.drawable.Icon.createWithResource(activity, R.drawable.ic_journal_tile), activity.mainExecutor) { result ->
                    val text = when (result) {
                        android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED -> "已添加「记一条」到控制中心"
                        android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> "控制中心已包含「记一条」"
                        android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED -> "未添加，原草稿保留，可稍后重试"
                        else -> "系统未完成添加，请在控制中心的编辑页手动添加 Hub「记一条」。"
                    }
                    invoke.resolve(JSObject().put("status", text).put("resultCode", result))
                }
            } catch (e: Exception) { invoke.reject("系统未完成添加，可在控制中心编辑页手动添加「记一条」") }
        }
    }
    @Command
    fun scheduleQuickJournal(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(QuickJournalScheduleArgs::class.java)
            QuickJournalWorker.schedule(activity.applicationContext, args.root)
            invoke.resolve()
        } catch (e: Exception) { invoke.reject("速记已保存在本机，后台任务安排失败") }
    }
    @Command
    fun readingNetworkState(invoke: Invoke) {
        try {
            val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val network = manager.activeNetwork
            val state = JSObject().put("supported", true)
            if (network == null) {
                invoke.resolve(state.put("connected", false).put("kind", "unknown").put("restricted", false))
                return
            }
            val caps = manager.getNetworkCapabilities(network)
            if (caps == null) {
                invoke.resolve(state.put("kind", "unknown").put("restricted", false))
                return
            }
            // Inspect the active default route, never SSID/IP or other location-sensitive details.
            val kind = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "unknown"
            }
            val metered = manager.isActiveNetworkMetered
            state.put("connected", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                .put("kind", kind)
                .put("metered", metered)
                .put("restricted", metered && manager.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED)
            // If the route changed during this read, refuse to classify the earlier network as current.
            if (manager.activeNetwork != network) {
                invoke.resolve(JSObject().put("supported", true).put("kind", "unknown").put("restricted", false))
            } else invoke.resolve(state)
        } catch (error: Exception) {
            invoke.reject("无法读取系统网络状态")
        }
    }

    @Command
    fun readFlashcardBackup(invoke: Invoke) {
        val args = invoke.parseArgs(FlashcardBackupReadArgs::class.java)
        Thread {
            var control: BackupCopyControl.Token? = null
            try {
                val accepted = BackupCopyControl.begin(args.operationId)
                control = accepted
                val uri = args.uri.toUri()
                require(uri.scheme == "content") { "请选择系统文件" }
                val target = java.io.File(args.destination).canonicalFile
                require(target.parentFile?.name == "flashcard-backups" && target.name.matches(Regex("import-[a-f0-9]{16}\\.partial"))) { "备份暂存路径无效" }
                require(target.createNewFile()) { "备份暂存文件已存在" }
                try {
                    activity.contentResolver.openInputStream(uri)?.let { stream -> accepted.use(stream) { input ->
                        accepted.use(target.outputStream()) { output ->
                            val buffer = ByteArray(64 * 1024)
                            var total = 0L
                            while (true) {
                                accepted.checkpoint()
                                val count = input.read(buffer)
                                if (count < 0) break
                                total += count
                                require(total <= 2L * 1024 * 1024 * 1024) { "备份文件超过 2 GB" }
                                accepted.checkpoint(); output.write(buffer, 0, count)
                            }
                            accepted.checkpoint()
                            output.fd.sync()
                        }
                    } } ?: error("无法读取备份文件")
                    accepted.checkpoint()
                    invoke.resolve()
                } catch (error: Exception) { target.delete(); throw error }
            } catch (error: Exception) { invoke.reject(error.message ?: "无法读取备份文件") }
            finally { control?.let { BackupCopyControl.finish(args.operationId, it) } }
        }.start()
    }

    @Command
    fun cancelFlashcardBackup(invoke: Invoke) {
        val args = invoke.parseArgs(FlashcardBackupCancelArgs::class.java)
        Thread {
            try { BackupCopyControl.cancel(args.operationId); invoke.resolve() }
            catch (error: Exception) { invoke.reject(error.message ?: "无法停止备份复制") }
        }.start()
    }

    @Command
    fun prepareFlashcardBackupExport(invoke: Invoke) {
        val args = invoke.parseArgs(AttachmentExportArgs::class.java)
        Thread {
            var control: BackupCopyControl.Token? = null
            var preparedToken: String? = null
            try {
                val id = requireNotNull(args.operationId) { "缺少备份操作标识" }
                val accepted = BackupCopyControl.begin(id)
                control = accepted
                val token = PendingAttachmentExport.prepare(activity.applicationContext, args, accepted)
                preparedToken = token
                accepted.checkpoint()
                invoke.resolve(JSObject().put("token", token))
            } catch (error: Exception) {
                preparedToken?.let { runCatching { PendingAttachmentExport.discard(activity.applicationContext, it) } }
                invoke.reject(error.message ?: "无法准备备份导出")
            }
            finally { control?.let { BackupCopyControl.finish(args.operationId!!, it) } }
        }.start()
    }

    @Command
    fun openFlashcardBackupExport(invoke: Invoke) {
        try {
            val token = invoke.parseArgs(PreparedAttachmentExportArgs::class.java).token
            val context = activity.applicationContext
            PendingAttachmentExport.read(context, token)
            activity.runOnUiThread {
                try {
                    context.startActivity(Intent(context, AttachmentExportActivity::class.java)
                        .putExtra(AttachmentExportActivity.TOKEN, token).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    invoke.resolve()
                } catch (error: Exception) { invoke.reject(error.message ?: "无法打开备份保存对话框") }
            }
        } catch (error: Exception) { invoke.reject(error.message ?: "备份导出暂存无效") }
    }

    @Command
    fun discardFlashcardBackupExport(invoke: Invoke) {
        try {
            PendingAttachmentExport.discard(activity.applicationContext, invoke.parseArgs(PreparedAttachmentExportArgs::class.java).token)
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message ?: "无法清理本次导出暂存") }
    }

    @Command
    fun exportFlashcardAttachment(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(AttachmentExportArgs::class.java)
            val context = activity.applicationContext
            // A binary snapshot may be large; stream it off the UI thread.
            Thread {
                try {
                    val token = PendingAttachmentExport.prepare(context, args)
                    activity.runOnUiThread {
                        try {
                            context.startActivity(Intent(context, AttachmentExportActivity::class.java)
                                .putExtra(AttachmentExportActivity.TOKEN, token)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            // Only confirms that the durable native save flow opened.
                            invoke.resolve()
                        } catch (error: Exception) {
                            PendingAttachmentExport.discard(context, token)
                            invoke.reject(error.message ?: "无法打开附件保存对话框")
                        }
                    }
                } catch (error: Exception) {
                    invoke.reject(error.message ?: "无法准备附件导出")
                }
            }.start()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法准备附件导出")
        }
    }

    @Command
    fun exportQualityDocument(invoke: Invoke) {
        try {
            val content = invoke.parseArgs(QualityDocumentExportArgs::class.java).content
            val token = PendingQualityDocument.prepare(activity, content)
            activity.startActivity(Intent(activity, QualityDocumentExportActivity::class.java)
                .putExtra(QualityDocumentExportActivity.TOKEN, token))
            // This means the native save flow has opened, not that the user has saved.
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法准备质量文档")
        }
    }

    @Command
    fun writeQualityDocument(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(QualityDocumentArgs::class.java)
            val uri = args.uri.toUri()
            require(uri.scheme == "content") { "请选择系统文档保存位置" }
            val stream = activity.contentResolver.openOutputStream(uri, "wt")
                ?: error("无法打开文档保存位置")
            stream.use { it.write(args.content.toByteArray(Charsets.UTF_8)) }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "无法保存质量文档")
        }
    }

    @Command
    fun openDida(invoke: Invoke) {
        try {
            val uri = invoke.parseArgs(SourceOpenArgs::class.java).url.toUri()
            require(uri.scheme in listOf("https", "http") && uri.host in listOf("dida365.com", "ticktick.com") && uri.path?.startsWith("/webapp") == true)
            val packages = if (uri.host == "dida365.com") listOf("cn.ticktick.task", "com.ticktick.task") else listOf("com.ticktick.task", "cn.ticktick.task")
            for (packageName in packages) {
                try {
                    activity.applicationContext.startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    invoke.resolve()
                    return
                } catch (_: ActivityNotFoundException) { /* Try the other edition, then the browser. */ }
            }
            activity.applicationContext.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message)
        }
    }
}
