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
        // NOTE: the startup guard runs in main() (it must cover `db`
        // subcommands too, which bypass boot()).
        create_app::<Self, Migrator>(mode, environment, config).await
    }

    async fn before_run(app_context: &AppContext) -> Result<()> {
        // Background loops:
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
        // Global layers:
        // CORS for /api/public/* first (outermost), then Origin/Referer
        // check, then rate limiting, then double-submit CSRF check.
        // Layers run last-added-first, so they are added in reverse
        // execution order.
        // NOTE: cors_public only adds `Access-Control-Allow-Origin` /
        // preflight handling so browsers can *read* public responses
        // cross-origin. It does NOT bypass the per-resource
        // `allowed_origins` gates inside each public controller
        // (mismatched origins still get an indistinguishable 404 body)
        // and origin_check below still guards every non-public route.
        Ok(router
            .layer(middleware::from_fn(crate::middleware::csrf::csrf_protection))
            .layer(middleware::from_fn(
                crate::middleware::rate_limit::limit_all,
            ))
            .layer(middleware::from_fn(crate::middleware::csrf::origin_check))
            .layer(middleware::from_fn(crate::middleware::cors::cors_public)))
        // NOTE: no fallback_service here on purpose — the SPA is served by
        // the explicit controllers::spa routes (registered last in routes()
        // so API mounts win). A fallback_service would be silently replaced
        // by Loco's own fallback middleware and answer 404 (see #spa-404).
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
            // SPA + uploads last: explicit routes (not a fallback service)
            // so API mounts always win and deep links return 200.
            .add_route(controllers::spa::routes())
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
        // ADMIN_EMAIL / ADMIN_PASSWORD.
        Ok(())
    }
}
