package com.craftsearch.desktop

import android.content.Context
import android.os.Bundle
import android.util.AtomicFile
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.util.UUID

/** The selected document is written natively, including after the OS reclaims Hub. */
class QualityDocumentExportActivity : ComponentActivity() {
    companion object { const val TOKEN = "qualityDocumentToken" }

    // Register in the same order on every creation so Android restores the pending result.
    private val saveDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        try {
            val snapshot = PendingQualityDocument.file(this, intent.getStringExtra(TOKEN) ?: error("缺少导出记录"))
            if (uri != null) {
                val content = AtomicFile(snapshot).openRead().use { it.readBytes() }
                val stream = contentResolver.openOutputStream(uri, "wt") ?: error("无法打开文档保存位置")
                stream.use { it.write(content); it.flush() }
                Toast.makeText(this, "质量文档已导出", Toast.LENGTH_LONG).show()
            }
            // Only our private staging file is removed; never delete the chosen document.
            AtomicFile(snapshot).delete()
        } catch (error: Exception) {
            Toast.makeText(this, "无法保存质量文档：${error.message ?: "请重新导出"}", Toast.LENGTH_LONG).show()
        } finally {
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val snapshot = PendingQualityDocument.file(this, intent.getStringExtra(TOKEN) ?: error("缺少导出记录"))
            require(snapshot.isFile) { "导出记录已失效，请重新导出" }
            if (savedInstanceState == null) saveDocument.launch("闪卡质量与制卡偏好.md")
        } catch (error: Exception) {
            Toast.makeText(this, error.message ?: "无法准备质量文档", Toast.LENGTH_LONG).show()
            finish()
        }
    }
}

internal object PendingQualityDocument {
    fun file(context: Context, token: String): File {
        require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(token)) { "导出记录无效" }
        val directory = File(context.filesDir, "quality-document-exports").canonicalFile
        val file = File(directory, "$token.md").canonicalFile
        require(file.parentFile == directory) { "导出位置无效" }
        return file
    }

    fun prepare(context: Context, content: String): String {
        val token = UUID.randomUUID().toString()
        val file = file(context, token)
        require(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs()) { "无法创建导出暂存位置" }
        val atomic = AtomicFile(file)
        val stream = atomic.startWrite()
        try {
            stream.write(content.toByteArray(Charsets.UTF_8))
            atomic.finishWrite(stream)
        } catch (error: Exception) {
            atomic.failWrite(stream)
            throw error
        }
        return token
    }
}
