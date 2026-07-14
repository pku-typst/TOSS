use super::oidc_group_model::OrgGroupRoleMapping;
use super::{
    delete_non_owner_organization_membership, grant_persistence,
    list_organization_membership_roles, oidc_group_persistence,
    upsert_organization_membership_role, OrganizationRole,
};
use chrono::Utc;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

pub(crate) async fn upsert_organization_group_mapping(
    db: &PgPool,
    organization_id: Uuid,
    group_name: &str,
    role: OrganizationRole,
) -> Result<OrgGroupRoleMapping, UpsertGroupMappingError> {
    let group_name = group_name.trim();
    if group_name.is_empty() {
        return Err(UpsertGroupMappingError::EmptyGroupName);
    }
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| UpsertGroupMappingError::Persistence {
                stage: GroupMappingMutationStage::Begin,
                organization_id,
                source,
            })?;
    let mapping = oidc_group_persistence::upsert_organization_mapping(
        &mut transaction,
        organization_id,
        group_name,
        role,
        Utc::now(),
    )
    .await
    .map_err(|source| UpsertGroupMappingError::Persistence {
        stage: GroupMappingMutationStage::Write,
        organization_id,
        source,
    })?;
    transaction
        .commit()
        .await
        .map_err(|source| UpsertGroupMappingError::Persistence {
            stage: GroupMappingMutationStage::Commit,
            organization_id,
            source,
        })?;
    Ok(mapping)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum GroupMappingMutationStage {
    Begin,
    Write,
    Commit,
}

#[derive(Debug, Error)]
pub(crate) enum UpsertGroupMappingError {
    #[error("OIDC group name is empty")]
    EmptyGroupName,
    #[error(
        "OIDC group mapping update failed during {stage:?} for organization {organization_id}"
    )]
    Persistence {
        stage: GroupMappingMutationStage,
        organization_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn delete_organization_group_mapping(
    db: &PgPool,
    organization_id: Uuid,
    group_name: &str,
) -> Result<(), DeleteGroupMappingError> {
    let mut transaction =
        db.begin()
            .await
            .map_err(|source| DeleteGroupMappingError::Persistence {
                stage: GroupMappingMutationStage::Begin,
                organization_id,
                source,
            })?;
    let deleted = oidc_group_persistence::delete_organization_mapping(
        &mut transaction,
        organization_id,
        group_name,
    )
    .await
    .map_err(|source| DeleteGroupMappingError::Persistence {
        stage: GroupMappingMutationStage::Write,
        organization_id,
        source,
    })?;
    if !deleted {
        return Err(DeleteGroupMappingError::NotFound {
            organization_id,
            group_name: group_name.to_string(),
        });
    }
    transaction
        .commit()
        .await
        .map_err(|source| DeleteGroupMappingError::Persistence {
            stage: GroupMappingMutationStage::Commit,
            organization_id,
            source,
        })?;
    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum DeleteGroupMappingError {
    #[error("OIDC group mapping {group_name} was not found for organization {organization_id}")]
    NotFound {
        organization_id: Uuid,
        group_name: String,
    },
    #[error(
        "OIDC group mapping deletion failed during {stage:?} for organization {organization_id}"
    )]
    Persistence {
        stage: GroupMappingMutationStage,
        organization_id: Uuid,
        #[source]
        source: sqlx::Error,
    },
}

pub(crate) async fn sync_oidc_identity_groups(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<Vec<Uuid>, SyncOidcGroupsError> {
    let mut transaction = db.begin().await.map_err(|source| SyncOidcGroupsError {
        stage: SyncOidcGroupsStage::Begin,
        user_id,
        organization_id: None,
        source,
    })?;
    let now = Utc::now();
    oidc_group_persistence::replace_user_groups(&mut transaction, user_id, groups, now)
        .await
        .map_err(|source| SyncOidcGroupsError {
            stage: SyncOidcGroupsStage::ReplaceUserGroups,
            user_id,
            organization_id: None,
            source,
        })?;
    let mappings = oidc_group_persistence::list_group_mappings(&mut transaction)
        .await
        .map_err(|source| SyncOidcGroupsError {
            stage: SyncOidcGroupsStage::LoadMappings,
            user_id,
            organization_id: None,
            source,
        })?;
    let current_memberships = list_organization_membership_roles(&mut transaction, user_id)
        .await
        .map_err(|source| SyncOidcGroupsError {
            stage: SyncOidcGroupsStage::LoadMemberships,
            user_id,
            organization_id: None,
            source,
        })?;
    let group_names = groups.iter().map(String::as_str).collect::<HashSet<_>>();
    let mapped_organization_ids = mappings
        .iter()
        .map(|mapping| mapping.organization_id)
        .collect::<HashSet<_>>();
    let mut desired_roles = HashMap::new();
    for mapping in mappings {
        if !group_names.contains(mapping.group_name.as_str()) {
            continue;
        }
        desired_roles
            .entry(mapping.organization_id)
            .and_modify(|current: &mut OrganizationRole| {
                if mapping.role.rank() > current.rank() {
                    *current = mapping.role;
                }
            })
            .or_insert(mapping.role);
    }
    let current_roles = current_memberships.into_iter().collect::<HashMap<_, _>>();
    let mut changed_organization_ids = HashSet::new();
    for (organization_id, desired_role) in &desired_roles {
        if !membership_role_needs_upsert(current_roles.get(organization_id), *desired_role) {
            continue;
        }
        upsert_organization_membership_role(
            &mut transaction,
            *organization_id,
            user_id,
            *desired_role,
            now,
        )
        .await
        .map_err(|source| SyncOidcGroupsError {
            stage: SyncOidcGroupsStage::UpsertMembership,
            user_id,
            organization_id: Some(*organization_id),
            source,
        })?;
        changed_organization_ids.insert(*organization_id);
    }
    for (organization_id, current_role) in current_roles {
        if current_role == OrganizationRole::Owner
            || desired_roles.contains_key(&organization_id)
            || !mapped_organization_ids.contains(&organization_id)
        {
            continue;
        }
        delete_non_owner_organization_membership(&mut transaction, organization_id, user_id)
            .await
            .map_err(|source| SyncOidcGroupsError {
                stage: SyncOidcGroupsStage::DeleteMembership,
                user_id,
                organization_id: Some(organization_id),
                source,
            })?;
        changed_organization_ids.insert(organization_id);
    }
    let changed_organization_ids = changed_organization_ids.into_iter().collect::<Vec<_>>();
    let affected_projects = grant_persistence::advance_organization_project_access_epochs(
        &mut transaction,
        &changed_organization_ids,
    )
    .await
    .map_err(|source| SyncOidcGroupsError {
        stage: SyncOidcGroupsStage::AdvanceProjectEpochs,
        user_id,
        organization_id: None,
        source,
    })?;
    transaction
        .commit()
        .await
        .map_err(|source| SyncOidcGroupsError {
            stage: SyncOidcGroupsStage::Commit,
            user_id,
            organization_id: None,
            source,
        })?;
    Ok(affected_projects)
}

#[derive(Debug)]
pub(crate) enum SyncOidcGroupsStage {
    Begin,
    ReplaceUserGroups,
    LoadMappings,
    LoadMemberships,
    UpsertMembership,
    DeleteMembership,
    AdvanceProjectEpochs,
    Commit,
}

#[derive(Debug, Error)]
#[error("OIDC group synchronization failed during {stage:?} for user {user_id} and organization {organization_id:?}")]
pub(crate) struct SyncOidcGroupsError {
    stage: SyncOidcGroupsStage,
    user_id: Uuid,
    organization_id: Option<Uuid>,
    #[source]
    source: sqlx::Error,
}

fn membership_role_needs_upsert(
    current_role: Option<&OrganizationRole>,
    desired_role: OrganizationRole,
) -> bool {
    !current_role.is_some_and(|current_role| {
        *current_role == desired_role || *current_role == OrganizationRole::Owner
    })
}

#[cfg(test)]
mod tests {
    use super::membership_role_needs_upsert;
    use crate::access::OrganizationRole;

    #[test]
    fn identity_group_sync_never_downgrades_an_owner() {
        assert!(!membership_role_needs_upsert(
            Some(&OrganizationRole::Owner),
            OrganizationRole::Member,
        ));
    }

    #[test]
    fn identity_group_sync_adds_and_upgrades_non_owner_memberships() {
        assert!(membership_role_needs_upsert(None, OrganizationRole::Member));
        assert!(membership_role_needs_upsert(
            Some(&OrganizationRole::Member),
            OrganizationRole::Owner,
        ));
        assert!(!membership_role_needs_upsert(
            Some(&OrganizationRole::Member),
            OrganizationRole::Member,
        ));
    }
}
