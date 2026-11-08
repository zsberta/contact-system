use async_trait::async_trait;
use loco_rs::{
    app::{AppContext, Hooks},
    bgworker::Queue,
    boot::{create_app, BootResult, StartMode},
    config::Config,
    controller::AppRoutes,
    environment::Environment,
    task::Tasks,
    Result,
};
use migration::Migrator;
use std::path::Path;

#[allow(unused_imports)]
use crate::{controllers, tasks};

pub struct App;

#[async_trait]
impl Hooks for App {
    fn app_name() -> &'static str {
        env!("CARGO_CRATE_NAME")
    }

    fn app_version() -> String {
        format!(
            "{} ({})",
            env!("CARGO_PKG_VERSION"),
            option_env!("BUILD_SHA")
                .or(option_env!("GITHUB_SHA"))
                .unwrap_or("dev")
        )
    }

    async fn boot(
        mode: StartMode,
        environment: &Environment,
        config: Config,
    ) -> Result<BootResult> {
        // Fail-fast on unsafe config (mirrors old_backend/lib/startup-guard.js).
        crate::startup_guard::assert_safe_startup();
        create_app::<Self, Migrator>(mode, environment, config).await
    }

    async fn before_run(app_context: &AppContext) -> Result<()> {
        // Background loops (mirror old_backend/server.js wiring):
        // mail queue drain, reservation reminders (60s), gateway payment
        // watch (120s), server-info snapshot, activity-log prune.
        crate::mailers::email::start();
        let db = app_context.db.clone();
        crate::workers::reminders::spawn(db.clone());
        crate::workers::gateway_watch::spawn(db.clone());
        crate::workers::server_info::spawn();
        crate::workers::prune::spawn(db);
        Ok(())
    }

    async fn after_routes(
        router: axum::Router,
        _ctx: &AppContext,
    ) -> Result<axum::Router> {
        use axum::middleware;
        // Global parity layers (mirror old_backend/server.js mounting order):
        // Origin/Referer check, then rate limiting, then double-submit
        // CSRF check. Layers run last-added-first, so they are added in
        // reverse execution order.
        let router = router
            .layer(middleware::from_fn(crate::middleware::csrf::csrf_protection))
            .layer(middleware::from_fn(
                crate::middleware::rate_limit::limit_all,
            ))
            .layer(middleware::from_fn(crate::middleware::csrf::origin_check));
        // SPA fallback: serve the Vite build (dist/) for non-API GETs.
        // The Docker image copies the frontend build to ./dist.
        let dist = std::env::var("FRONTEND_DIST").unwrap_or_else(|_| "dist".to_string());
        let router = if std::path::Path::new(&dist).join("index.html").exists() {
            router.fallback_service(
                axum::routing::get_service(tower_http::services::ServeDir::new(&dist).not_found_service(
                    tower_http::services::ServeFile::new(format!("{dist}/index.html")),
                )),
            )
        } else {
            router
        };
        Ok(router)
    }

    fn routes(_ctx: &AppContext) -> AppRoutes {
        AppRoutes::with_default_routes()
            .add_route(controllers::auth::routes())
            .add_route(controllers::csrf::routes())
            .add_route(controllers::dashboard::routes())
            .add_route(controllers::users::routes())
            .add_route(controllers::projects::routes())
            .add_route(controllers::payments::routes())
            .add_route(controllers::payment_attachments::routes())
            .add_route(controllers::forms::routes())
            .add_route(controllers::form_embed::routes())
            .add_route(controllers::reservations::routes())
            .add_route(controllers::reservation_embed::routes())
            .add_route(controllers::imports::routes())
            .add_route(controllers::bulk_email::routes())
            .add_route(controllers::notifications::routes())
            .add_route(controllers::settings::routes())
            .add_route(controllers::analytics::routes())
            .add_route(controllers::analytics_embed::routes())
            .add_route(controllers::submissions::routes())
            .add_route(controllers::project_modules::routes())
            .add_route(controllers::blog::routes())
            .add_route(controllers::blog_attachments::routes())
            .add_route(controllers::blog_public::routes())
            .add_route(controllers::faq::routes())
            .add_route(controllers::faq_public::routes())
            .add_route(controllers::service::routes())
            .add_route(controllers::service_public::routes())
            .add_route(controllers::ai_assistant::routes())
            .add_route(controllers::ai_assistant_embed::routes())
            .add_route(controllers::ai_config_presets::routes())
            .add_route(controllers::internal::routes())
            .add_route(controllers::logs::routes())
            .add_route(controllers::server_info::routes())
            .add_route(controllers::gateway::routes())
            .add_route(controllers::health::routes())
    }

    async fn connect_workers(_ctx: &AppContext, _queue: &Queue) -> Result<()> {
        Ok(())
    }

    fn register_tasks(tasks: &mut Tasks) {
        tasks.register(tasks::seed_admin::SeedAdmin);
    }

    async fn truncate(_ctx: &AppContext) -> Result<()> {
        Ok(())
    }

    async fn seed(_ctx: &AppContext, _base: &Path) -> Result<()> {
        // Admin seeding is handled by the seed_admin task reading
        // ADMIN_EMAIL / ADMIN_PASSWORD (parity with old db/seed.js).
        Ok(())
    }
}
