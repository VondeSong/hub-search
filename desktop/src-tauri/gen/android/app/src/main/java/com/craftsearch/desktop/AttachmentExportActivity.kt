package com.craftsearch.desktop

import android.app.Activity
import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.util.AtomicFile
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID

/** Owns the selected document and can complete without a surviving WebView. */
class AttachmentExportActivity : ComponentActivity() {
    companion object { const val TOKEN = "attachmentExportToken" }
    private var copying = false
    private var progress: ProgressDialog? = null
    // Registration order stays stable when Android restores the pending SAF result.
    private val saveDocument = registerForActivityResult(CreateAttachmentDocument()) { selected ->
        val token = intent.getStringExtra(TOKEN)
        try {
            requireNotNull(token) { "缺少附件导出记录" }
            if (selected == null) {
                PendingAttachmentExport.discard(this, token)
                finish()
            } else {
                PendingAttachmentExport.select(this, token, selected)
                copyDocument(token)
            }
        } catch (error: Exception) { fail(error) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val token = intent.getStringExtra(TOKEN) ?: error("缺少附件导出记录")
            val job = PendingAttachmentExport.read(this, token)
            if (job.destination != null || job.completed) copyDocument(token)
            else if (savedInstanceState == null) saveDocument.launch(job)
        } catch (error: Exception) { fail(error) }
    }

    private fun copyDocument(token: String) {
        if (copying) return
        copying = true
        val context = applicationContext
        progress = ProgressDialog(this).apply {
            setTitle("正在保存文件")
            setMessage("正在复制并校验文件…")
            setIndeterminate(true)
            setCancelable(false)
            setButton(ProgressDialog.BUTTON_NEGATIVE, "停止操作") { _, _ ->
                setMessage("正在停止复制…")
                // Closing a document-provider stream may block; keep it off UI.
                Thread { runCatching { PendingAttachmentExport.cancel(context, token) } }.start()
            }
            show()
        }
        Thread {
            try {
                PendingAttachmentExport.copy(context, token)
                runOnUiThread {
                    progress?.dismiss()
                    Toast.makeText(context, "附件已保存", Toast.LENGTH_LONG).show()
                    finish()
                }
            } catch (error: Exception) { runOnUiThread { fail(error) } }
        }.start()
    }

    private fun fail(error: Exception) {
        progress?.dismiss()
        val message = if (error.message?.contains("BACKUP_CANCELLED:") == true) "文件保存已停止，原备份仍会保留"
            else "无法保存附件：${error.message ?: "请重新导出"}"
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    override fun onDestroy() {
        progress?.dismiss()
        progress = null
        super.onDestroy()
    }
}

internal data class AttachmentExportJob(
    val fileName: String, val mimeType: String, val hash: String, val size: Long,
    val createdAt: Long, val destination: String? = null,
    val ownedWriteGrant: Boolean = false, val completed: Boolean = false,
    val operationId: String? = null, val cancelled: Boolean = false
)
internal data class SelectedAttachmentDocument(val uri: Uri, val flags: Int)

private class CreateAttachmentDocument : ActivityResultContract<AttachmentExportJob, SelectedAttachmentDocument?>() {
    override fun createIntent(context: Context, input: AttachmentExportJob) =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.mimeType).putExtra(Intent.EXTRA_TITLE, input.fileName)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    override fun parseResult(resultCode: Int, intent: Intent?): SelectedAttachmentDocument? {
        if (resultCode != Activity.RESULT_OK) return null
        val uri = intent?.data ?: return null
        return SelectedAttachmentDocument(uri, intent.flags)
    }
}

internal object PendingAttachmentExport {
    private const val MAX_BYTES = 250L * 1024 * 1024
    private fun sizeLimit(name: String) = if (name.endsWith(".hubfc")) 2L * 1024 * 1024 * 1024 else MAX_BYTES
    private const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    private val tokenPattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private val mimePattern = Regex("[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*")
    private val copyLock = Any()

    private fun directory(context: Context, token: String): File {
        require(tokenPattern.matches(token)) { "附件导出记录无效" }
        val root = File(context.filesDir, "attachment-exports").canonicalFile
        val directory = File(root, token).canonicalFile
        require(directory.parentFile == root) { "附件导出位置无效" }
        return directory
    }
    private fun snapshot(context: Context, token: String) = AtomicFile(File(directory(context, token), "blob"))
    private fun record(context: Context, token: String) = AtomicFile(File(directory(context, token), "job.json"))

    fun prepare(context: Context, args: AttachmentExportArgs, control: BackupCopyControl.Token? = null): String {
        control?.checkpoint()
        require(Regex("[a-f0-9]{64}").matches(args.hash)) { "附件哈希无效" }
        val source = File(args.sourcePath).canonicalFile
        val attachment = source.name.equals(args.hash, ignoreCase = true)
            && source.parentFile?.name.equals(args.hash.take(2), ignoreCase = true)
            && source.parentFile?.parentFile?.name == "blobs-v1"
        val backup = source.parentFile?.name == "flashcard-backups" && source.extension == "hubfc"
        require(source.isFile && (attachment || backup)) { "导出文件本地位置无效" }
        val name = args.fileName.substringAfterLast('/').substringAfterLast('\\').trim()
        require(name.isNotEmpty() && name.length <= 4096 && name.none { it.code < 32 }) { "附件文件名无效" }
        val mime = args.mimeType.trim()
        require(mime.length <= 255 && mimePattern.matches(mime)) { "附件类型无效" }
        pruneExpired(context)
        val token = UUID.randomUUID().toString()
        val directory = directory(context, token)
        require(directory.mkdirs()) { "无法创建附件导出暂存位置" }
        val atomic = snapshot(context, token)
        val output = atomic.startWrite()
        try {
            val size = source.inputStream().use { copyVerified(it, output, args.hash, sizeLimit(name), control) }
            control?.checkpoint()
            atomic.finishWrite(output)
            write(context, token, AttachmentExportJob(name, mime, args.hash, size, System.currentTimeMillis(), operationId = args.operationId))
            control?.checkpoint()
        } catch (error: Exception) {
            atomic.failWrite(output)
            discard(context, token)
            throw error
        }
        return token
    }

    fun read(context: Context, token: String): AttachmentExportJob {
        val json = record(context, token).openRead().use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
        val job = AttachmentExportJob(json.getString("fileName"), json.getString("mimeType"),
            json.getString("hash"), json.getLong("size"), json.getLong("createdAt"),
            json.optString("destination").takeIf { it.isNotEmpty() },
            json.optBoolean("ownedWriteGrant"), json.optBoolean("completed"),
            json.optString("operationId").takeIf { it.isNotEmpty() }, json.optBoolean("cancelled"))
        require(Regex("[a-f0-9]{64}").matches(job.hash) && job.size in 1..sizeLimit(job.fileName)
            && mimePattern.matches(job.mimeType) && job.fileName.isNotEmpty()) { "附件导出记录无效" }
        require(job.completed || snapshot(context, token).baseFile.isFile) { "附件导出暂存已失效，请重新导出" }
        return job
    }

    private fun write(context: Context, token: String, job: AttachmentExportJob) {
        val json = JSONObject().put("fileName", job.fileName).put("mimeType", job.mimeType)
            .put("hash", job.hash).put("size", job.size).put("createdAt", job.createdAt)
            .put("destination", job.destination ?: "").put("ownedWriteGrant", job.ownedWriteGrant)
            .put("completed", job.completed)
            .put("operationId", job.operationId ?: "").put("cancelled", job.cancelled)
        val atomic = record(context, token)
        val output = atomic.startWrite()
        try {
            output.write(json.toString().toByteArray(Charsets.UTF_8))
            atomic.finishWrite(output)
        } catch (error: Exception) { atomic.failWrite(output); throw error }
    }

    private fun ownWriteGrant(context: Context, uri: Uri): Boolean =
        context.contentResolver.persistedUriPermissions.none { it.uri == uri && it.isWritePermission }

    internal fun select(context: Context, token: String, selected: SelectedAttachmentDocument) {
        val job = read(context, token)
        require(!job.completed && !job.cancelled && job.destination == null && selected.uri.scheme == "content"
            && selected.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0) { "请选择系统文档保存位置" }
        val owned = ownWriteGrant(context, selected.uri)
        // Keep the user's selected write capability across process recreation.
        context.contentResolver.takePersistableUriPermission(selected.uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        write(context, token, job.copy(destination = selected.uri.toString(), ownedWriteGrant = owned))
    }

    fun copy(context: Context, token: String) = synchronized(copyLock) {
        val job = read(context, token)
        if (job.completed) return@synchronized
        check(!job.cancelled) { "BACKUP_CANCELLED:文件保存已停止" }
        val uri = Uri.parse(job.destination ?: error("尚未选择附件保存位置"))
        require(uri.scheme == "content" && !ownWriteGrant(context, uri)) { "附件保存权限已失效，请重新导出" }
        val id = job.operationId ?: "attachment-$token"
        val control = BackupCopyControl.begin(id)
        try {
            val output = context.contentResolver.openOutputStream(uri, "wt") ?: error("无法打开附件保存位置")
            control.use(output) { stream ->
                val size = control.use(snapshot(context, token).openRead()) { input -> copyVerified(input, stream, job.hash, sizeLimit(job.fileName), control) }
                require(size == job.size) { "附件大小校验失败" }
                control.checkpoint(); stream.flush()
            }
            // Completion and cancellation share this exact operation's barrier.
            control.commit { write(context, token, job.copy(completed = true)) }
        } catch (error: Exception) {
            try { control.checkpoint() }
            catch (cancelled: Exception) {
                // ACTION_CREATE_DOCUMENT produced this new partial document.
                // Discard it instead of leaving an apparently usable backup.
                runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
                throw cancelled
            }
            throw error
        } finally {
            BackupCopyControl.finish(id, control)
        }
        snapshot(context, token).delete()
        if (job.ownedWriteGrant) runCatching {
            context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }

    private fun copyVerified(input: InputStream, output: OutputStream, hash: String, limit: Long, control: BackupCopyControl.Token? = null): Long {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var size = 0L
        while (true) {
            control?.checkpoint()
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            size += count
            require(size <= limit) { "导出文件超过大小上限" }
            digest.update(buffer, 0, count)
            control?.checkpoint(); output.write(buffer, 0, count)
        }
        control?.checkpoint()
        require(size > 0 && digest.digest().joinToString("") { "%02x".format(it) } == hash) { "附件完整性校验失败" }
        return size
    }

    fun cancel(context: Context, token: String): Boolean {
        val job = read(context, token)
        if (job.completed) return false
        val accepted = BackupCopyControl.cancel(job.operationId ?: "attachment-$token")
        if (accepted) write(context, token, job.copy(cancelled = true))
        return accepted
    }

    fun discard(context: Context, token: String) {
        val job = runCatching { read(context, token) }.getOrNull()
        if (job?.ownedWriteGrant == true && job.destination != null) runCatching {
            context.contentResolver.releasePersistableUriPermission(Uri.parse(job.destination), Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        snapshot(context, token).delete()
        record(context, token).delete()
        directory(context, token).delete()
    }

    private fun pruneExpired(context: Context) = synchronized(copyLock) {
        val root = File(context.filesDir, "attachment-exports").canonicalFile
        val cutoff = System.currentTimeMillis() - RETENTION_MS
        root.listFiles()?.filter { it.isDirectory && tokenPattern.matches(it.name) }?.forEach { directory ->
            if (directory.canonicalFile.parentFile == root && directory.lastModified() < cutoff) discard(context, directory.name)
        }
    }
}
