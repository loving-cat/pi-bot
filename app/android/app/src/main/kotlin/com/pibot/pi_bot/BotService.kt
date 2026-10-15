package com.pibot.pi_bot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * 常驻前台服务：唯一目的是**别让系统把进程杀掉**。
 *
 * WebSocket 长连接跑在 Flutter 主 isolate 里，只要进程活着就能一直收消息、
 * 弹本地通知。所以这里不做任何业务逻辑，只挂一个低优先级的常驻通知。
 */
class BotService : Service() {

    companion object {
        const val CHANNEL_ID = "pibot_service"
        const val NOTIFY_ID = 1001
        const val ACTION_START = "com.pibot.pi_bot.START"
        const val ACTION_STOP = "com.pibot.pi_bot.STOP"

        fun start(context: Context) {
            val intent = Intent(context, BotService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, BotService::class.java).setAction(ACTION_STOP))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(true)
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannel()
        startForeground(NOTIFY_ID, buildNotification())
        // 被系统杀掉后自动重启，尽量保持在线
        return START_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "后台常驻",
            NotificationManager.IMPORTANCE_MIN,
        ).apply {
            description = "保持与 pi-bot 服务端的连接，以便随时收到机器人的消息"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("pi-bot 在线")
            .setContentText("保持连接中，机器人干活完会通知你")
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentIntent(pending)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setShowWhen(false)
            .build()
    }
}
