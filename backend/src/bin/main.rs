use contact_system::app::App;
use loco_rs::cli;
use migration::Migrator;

#[tokio::main]
async fn main() -> loco_rs::Result<()> {
    // Fail-fast on unsafe config for EVERY subcommand (migrate, seed,
    // start). Hooks::boot doesn't run for `db` subcommands, so the guard
    // lives here — the one place all paths funnel through (fail-fast via
    // process exit).
    contact_system::startup_guard::assert_safe_startup();
    cli::main::<App, Migrator>().await
}
