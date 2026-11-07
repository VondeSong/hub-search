package com.craftsearch.desktop

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

/** Persistent queue drain; never depends on a visible Activity or WebView. */
class QuickJournalWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val root = inputData.getString("root") ?: return Result.failure()
        return try { if (syncNative(root)) Result.success() else Result.retry() }
        catch (_: Exception) { Result.retry() }
    }
    companion object {
        init { System.loadLibrary("craft_search_lib") }
        @JvmStatic external fun syncNative(root: String): Boolean
        fun schedule(context: Context, root: String) {
            val data = workDataOf("root" to root)
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val manager = WorkManager.getInstance(context)
            // Append a wake-up so a save racing the end of a running drain is never lost.
            manager.enqueueUniqueWork("hub-quick-journal", ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<QuickJournalWorker>().setInputData(data)
                    .setConstraints(constraints).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
            manager.enqueueUniquePeriodicWork("hub-quick-journal-receipts", ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<QuickJournalWorker>(15, TimeUnit.MINUTES)
                    .setInputData(data).setConstraints(constraints).build())
        }
    }
}
