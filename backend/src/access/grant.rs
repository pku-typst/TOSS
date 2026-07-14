use super::grant_model::{
    ProjectAccessSource, ProjectAccessUser, ProjectGroupRoleBinding, ProjectOrganizationAccess,
    ProjectRoleBinding,
};
use super::grant_persistence;
use super::organization_user_is_member;
use super::{ProjectPermission, ProjectRole};
use chrono::Utc;
use sqlx::{PgConnection, PgPool};
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;

pub(crate) async fn grant_initial_project_owner(
    connection: &mut PgConnection,
    project_id: Uuid,
    owner_user_id: Uuid,
    granted_at: chrono::DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    grant_persistence::upsert_role(
        connection,
        project_id,
        owner_user_id,
        ProjectRole::Owner,
        granted_at,
    )
    .await?;
    Ok(())
}

pub(crate) async fn upsert_project_role(
    db: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
    role: ProjectRole,
) -> Result<ProjectRoleBinding, sqlx::Error> {
    let mut transaction = db.begin().await?;
    let binding =
        grant_persistence::upsert_role(&mut transaction, project_id, user_id, role, Utc::now())
            .await?;
    grant_persistence::advance_project_access_epoch(&mut transaction, project_id).await?;
    transaction.commit().await?;
    Ok(binding)
}

pub(crate) async fn upsert_project_organization_access(
    db: &PgPool,
    project_id: Uuid,
    organization_id: Uuid,
    permission: ProjectPermission,
    actor_user_id: Uuid,
) -> Result<ProjectOrganizationAccess, UpsertOrganizationAccessError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| UpsertOrganizationAccessError::Persistence {
                stage: GrantMutationStage::Begin,
                project_id,
                organization_id,
                source,
            })?;
    let actor_is_member =
        organization_user_is_member(&mut transaction, actor_user_id, organization_id)
            .await
            .map_err(|source| UpsertOrganizationAccessError::Persistence {
                stage: GrantMutationStage::CheckPolicy,
                project_id,
                organization_id,
                source,
            })?;
    if !actor_is_member {
        return Err(UpsertOrganizationAccessError::ActorNotMember {
            actor_user_id,
            organization_id,
        });
    }
    let access = grant_persistence::upsert_organization_access(
        &mut transaction,
        project_id,
        organization_id,
        permission,
        actor_user_id,
        Utc::now(),
    )
    .await
    .map_err(|source| UpsertOrganizationAccessError::Persistence {
        stage: GrantMutationStage::Write,
        project_id,
        organization_id,
        source,
    })?;
    grant_persistence::advance_project_access_epoch(&mut transaction, project_id)
        .await
        .map_err(|source| UpsertOrganizationAccessError::Persistence {
            stage: GrantMutationStage::Write,
            project_id,
            organization_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| UpsertOrganizationAccessError::Persistence {
            stage: GrantMutationStage::Commit,
            project_id,
            organization_id,
            source,
        })?;
    Ok(access)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum GrantMutationStage {
    Begin,
    CheckPolicy,
    Write,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum UpsertOrganizationAccessError {
    #[error("user {actor_user_id} is not a member of organization {organization_id}")]
    ActorNotMember {
        actor_user_id: Uuid,
        organization_id: Uuid,
    },
    #[error("organization access update failed during {stage:?} for project {project_id} and organization {organization_id}")]
    Persistence {
        stage: GrantMutationStage,
        project_id: Uuid,
        organization_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn delete_project_organization_access(
    db: &PgPool,
    project_id: Uuid,
    organization_id: Uuid,
) -> Result<(), DeleteOrganizationAccessError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| DeleteOrganizationAccessError::Persistence {
                stage: GrantMutationStage::Begin,
                project_id,
                organization_id,
                source,
            })?;
    let deleted = grant_persistence::delete_organization_access(
        &mut transaction,
        project_id,
        organization_id,
    )
    .await
    .map_err(|source| DeleteOrganizationAccessError::Persistence {
        stage: GrantMutationStage::Write,
        project_id,
        organization_id,
        source,
    })?;
    if !deleted {
        return Err(DeleteOrganizationAccessError::NotFound {
            project_id,
            organization_id,
        });
    }
    grant_persistence::advance_project_access_epoch(&mut transaction, project_id)
        .await
        .map_err(|source| DeleteOrganizationAccessError::Persistence {
            stage: GrantMutationStage::Write,
            project_id,
            organization_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| DeleteOrganizationAccessError::Persistence {
            stage: GrantMutationStage::Commit,
            project_id,
            organization_id,
            source,
        })?;
    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum DeleteOrganizationAccessError {
    #[error("organization {organization_id} has no access grant for project {project_id}")]
    NotFound {
        project_id: Uuid,
        organization_id: Uuid,
    },
    #[error("organization access deletion failed during {stage:?} for project {project_id} and organization {organization_id}")]
    Persistence {
        stage: GrantMutationStage,
        project_id: Uuid,
        organization_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn list_project_access_users(
    db: &PgPool,
    project_id: Uuid,
) -> Result<Vec<ProjectAccessUser>, sqlx::Error> {
    let (direct_users, organization_users) = tokio::try_join!(
        grant_persistence::direct_access_users(db, project_id),
        grant_persistence::organization_access_users(db, project_id),
    )?;
    let mut users = HashMap::new();
    for user in direct_users {
        merge_access_user(
            &mut users,
            user.user_id,
            user.email,
            user.display_name,
            user.role,
            user.source.into(),
        );
    }
    for user in organization_users {
        merge_access_user(
            &mut users,
            user.user_id,
            user.email,
            user.display_name,
            user.permission.project_role(),
            ProjectAccessSource::Organization {
                name: user.organization_name,
            },
        );
    }
    let mut output = users.into_values().collect::<Vec<_>>();
    for user in &mut output {
        user.sources.sort();
    }
    output.sort_by_cached_key(|user| user.display_name.to_lowercase());
    Ok(output)
}

fn merge_access_user(
    users: &mut HashMap<Uuid, ProjectAccessUser>,
    user_id: Uuid,
    email: String,
    display_name: String,
    role: ProjectRole,
    source: ProjectAccessSource,
) {
    let access_type = role.access_type();
    users
        .entry(user_id)
        .and_modify(|entry| {
            if role.rank() > entry.role.rank() {
                entry.role = role;
                entry.access_type = access_type;
            }
            if !entry.sources.contains(&source) {
                entry.sources.push(source.clone());
            }
        })
        .or_insert_with(|| ProjectAccessUser {
            user_id,
            email,
            display_name,
            role,
            access_type,
            sources: vec![source],
        });
}

pub(crate) async fn upsert_project_group_role(
    db: &PgPool,
    project_id: Uuid,
    group_name: &str,
    role: ProjectRole,
) -> Result<ProjectGroupRoleBinding, UpsertGroupRoleError> {
    let group_name =
        normalize_group_name(group_name).ok_or(UpsertGroupRoleError::EmptyGroupName)?;
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| UpsertGroupRoleError::Persistence {
            stage: GrantMutationStage::Begin,
            project_id,
            source,
        })?;
    let binding = grant_persistence::upsert_group_role(
        &mut transaction,
        project_id,
        group_name,
        role,
        Utc::now(),
    )
    .await
    .map_err(|source| UpsertGroupRoleError::Persistence {
        stage: GrantMutationStage::Write,
        project_id,
        source,
    })?;
    grant_persistence::advance_project_access_epoch(&mut transaction, project_id)
        .await
        .map_err(|source| UpsertGroupRoleError::Persistence {
            stage: GrantMutationStage::Write,
            project_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| UpsertGroupRoleError::Persistence {
            stage: GrantMutationStage::Commit,
            project_id,
            source,
        })?;
    Ok(binding)
}

fn normalize_group_name(group_name: &str) -> Option<&str> {
    let group_name = group_name.trim();
    if group_name.is_empty() {
        return None;
    }
    Some(group_name)
}

#[derive(Debug, Error)]
pub(crate) enum UpsertGroupRoleError {
    #[error("project group name is empty")]
    EmptyGroupName,
    #[error("project group role update failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: GrantMutationStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn delete_project_group_role(
    db: &PgPool,
    project_id: Uuid,
    group_name: &str,
) -> Result<(), DeleteGroupRoleError> {
    let group_name =
        normalize_group_name(group_name).ok_or(DeleteGroupRoleError::EmptyGroupName)?;
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| DeleteGroupRoleError::Persistence {
            stage: GrantMutationStage::Begin,
            project_id,
            source,
        })?;
    let deleted = grant_persistence::delete_group_role(&mut transaction, project_id, group_name)
        .await
        .map_err(|source| DeleteGroupRoleError::Persistence {
            stage: GrantMutationStage::Write,
            project_id,
            source,
        })?;
    if !deleted {
        return Err(DeleteGroupRoleError::NotFound {
            project_id,
            group_name: group_name.to_string(),
        });
    }
    grant_persistence::advance_project_access_epoch(&mut transaction, project_id)
        .await
        .map_err(|source| DeleteGroupRoleError::Persistence {
            stage: GrantMutationStage::Write,
            project_id,
            source,
        })?;
    transaction
        .commit()
        .await
        .map_err(|source| DeleteGroupRoleError::Persistence {
            stage: GrantMutationStage::Commit,
            project_id,
            source,
        })?;
    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum DeleteGroupRoleError {
    #[error("project group name is empty")]
    EmptyGroupName,
    #[error("group {group_name} has no role for project {project_id}")]
    NotFound {
        project_id: Uuid,
        group_name: String,
    },
    #[error("project group role deletion failed during {stage:?} for project {project_id}")]
    Persistence {
        stage: GrantMutationStage,
        project_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::normalize_group_name;

    #[test]
    fn group_names_are_trimmed_and_must_not_be_empty() {
        assert_eq!(normalize_group_name("  nv-docs  "), Some("nv-docs"));
        assert_eq!(normalize_group_name(" \t "), None);
    }
}
