//! Background workers.
//! Each worker runs as a Loco BackgroundWorker on the queue; the interval
//! loops become worker schedules.

pub struct EmailQueueWorker;
pub struct GatewayWatchWorker;
pub struct RemindersWorker;
pub struct ServerInfoWorker;

#[allow(dead_code)]
pub fn schedules() -> Vec<(&'static str, &'static str)> {
    vec![
        // Mirrors lib/email-queue.js pacing + lib/reservation-reminders.js,
        // lib/gateway-payments.js (120s), lib/server-info.js cadences.
        ("email_queue", "*/5 * * * * *"),
        ("gateway_watch", "*/120 * * * * *"),
        ("reminders", "*/60 * * * * *"),
        ("server_info", "*/60 * * * * *"),
    ]
}
