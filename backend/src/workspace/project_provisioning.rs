//! Atomic project provisioning shared by every project-creation workflow.

use super::{persistence, CreateProjectGraph};
use sqlx::PgConnection;

pub(crate) async fn provision_project(
    connection: &mut PgConnection,
    project: &CreateProjectGraph<'_>,
) -> Result<(), sqlx::Error> {
    persistence::create_project_graph(connection, project).await?;
    crate::access::grant_initial_project_owner(
        connection,
        project.project_id,
        project.owner_user_id,
        project.created_at,
    )
    .await?;
    crate::versioning::initialize_project(connection, project.project_id).await
}
