import type { components } from "@/lib/api/generated";

export type ApiSchema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

export type ApiErrorCode = ApiSchema<"ApiErrorCode">;
export type ApiErrorPayload = ApiSchema<"ApiErrorResponse">;

export type ProjectRole = ApiSchema<"ProjectRole">;
export type ProjectAccessType = ApiSchema<"ProjectAccessType">;
export type OrganizationMembershipRole = ApiSchema<"OrganizationRole">;
export type ProjectPermission = ApiSchema<"ProjectPermission">;
export type ProjectType = ApiSchema<"ProjectType">;
export type FrontendFeature = ApiSchema<"FrontendFeature">;
export type ProjectFileKind = ApiSchema<"ProjectFileKind">;
export type LatexEngine = ApiSchema<"LatexEngine">;
export type AnonymousMode = ApiSchema<"AnonymousMode">;
export type ExperienceResourceKind = ApiSchema<"ExperienceResourceKind">;
export type TemplateSource = ApiSchema<"TemplateSource">;
export type ExternalGitGrantStatus = ApiSchema<"ExternalGitGrantStatus">;
export type ExternalGitRepositoryVisibility =
  ApiSchema<"ExternalGitRepositoryVisibility">;
export type ExternalGitInboundOperation = ApiSchema<"ExternalGitInboundOperation">;
export type ExternalGitJobState = ApiSchema<"ExternalGitJobState">;
export type ExternalGitInboundPhase = ApiSchema<"ExternalGitInboundPhase">;
export type ExternalGitCheckpointPhase = ApiSchema<"ExternalGitCheckpointPhase">;
export type ExternalGitLinkStatus = ApiSchema<"ExternalGitLinkStatus">;
export type ExternalGitProjectState = ApiSchema<"ExternalGitProjectState">;
export type ProcessingOperation = ApiSchema<"ProcessingOperation">;
export type ProcessingJobState = ApiSchema<"ProcessingJobState">;
export type ProcessingPhase = ApiSchema<"ProcessingPhase">;
export type ProcessingCapabilityState = ApiSchema<"ProcessingCapabilityState">;
export type ProjectProcessingCapabilityState =
  ApiSchema<"ProjectProcessingCapabilityState">;
export type ProcessingInputProfile = ApiSchema<"ProcessingInputProfile">;
export type ProcessingInputProfileSelector =
  ApiSchema<"ProcessingInputProfileSelector">;
export type ProcessingArtifact = ApiSchema<"ProcessingArtifact">;
export type ProcessingFailure = ApiSchema<"ProcessingFailure">;
export type ProcessingJob = ApiSchema<"ProcessingJob">;
export type ProcessingJobList = ApiSchema<"ProcessingJobList">;
export type ProcessingCapability = ApiSchema<"ProcessingCapability">;
export type ProcessingCapabilities = ApiSchema<"ProcessingCapabilities">;
export type ProjectProcessingCapability = ApiSchema<"ProjectProcessingCapability">;
export type ProjectProcessingCapabilities = ApiSchema<"ProjectProcessingCapabilities">;

export type OrganizationMembership = ApiSchema<"OrganizationMembership">;
export type Organization = ApiSchema<"Organization">;
export type OrganizationListResponse = ApiSchema<"OrganizationListResponse">;
export type OrganizationMembershipListResponse =
  ApiSchema<"OrganizationMembershipListResponse">;
export type CreateOrganizationInput = ApiSchema<"CreateOrganizationInput">;

export type Project = ApiSchema<"Project">;
export type ProjectListResponse = ApiSchema<"ProjectListResponse">;
export type ProjectTreeNode = ApiSchema<"ProjectFileNode">;
export type ProjectTreeResponse = ApiSchema<"ProjectTreeResponse">;
export type ProjectSettings = ApiSchema<"ProjectSettings">;
export type TemplateStatus = ApiSchema<"TemplateStatus">;
export type TemplateOrganizationGrant = ApiSchema<"TemplateOrganizationGrant">;

export type LocalizedText = ApiSchema<"LocalizedText">;
export type TemplateGalleryItem = ApiSchema<"TemplateGalleryItem">;
export type TemplateGalleryResponse = ApiSchema<"TemplateGalleryResponse">;
export type ExperienceProduct = ApiSchema<"ExperienceProduct">;
export type ExperienceLandingHighlight = ApiSchema<"ExperienceLandingHighlight">;
export type ExperienceLanding = ApiSchema<"ExperienceLanding">;
export type ExperienceResource = ApiSchema<"ExperienceResource">;
export type Experience = ApiSchema<"Experience">;
export type HelpTopic = ApiSchema<"HelpTopic">;
export type HelpContent = ApiSchema<"HelpContent">;

export type GitRepoLink = ApiSchema<"GitRepoLink">;
export type GitSyncState = ApiSchema<"GitSyncState">;
export type Document = ApiSchema<"Document">;
export type DocumentsResponse = ApiSchema<"DocumentsResponse">;
export type ProjectAsset = ApiSchema<"ProjectAsset">;
export type ProjectAssetContentResponse = ApiSchema<"ProjectAssetContentResponse">;
export type ProjectAssetListResponse = ApiSchema<"ProjectAssetListResponse">;

export type RevisionAuthor = ApiSchema<"RevisionAuthor">;
export type Revision = ApiSchema<"Revision">;
export type RevisionsResponse = ApiSchema<"RevisionsResponse">;
export type RevisionDocument = ApiSchema<"RevisionDocument">;
export type RevisionAsset = ApiSchema<"RevisionAsset">;
export type RevisionTransfer = ApiSchema<"RevisionTransfer">;
export type PdfArtifact = ApiSchema<"PdfArtifact">;

export type PersonalAccessTokenInfo = ApiSchema<"PersonalAccessTokenInfo">;
export type PersonalAccessTokenListResponse =
  ApiSchema<"PersonalAccessTokenListResponse">;
export type CreatePatResponse = ApiSchema<"CreatePatResponse">;
export type OrgGroupRoleMapping = ApiSchema<"OrgGroupRoleMapping">;

export type AuthConfig = ApiSchema<"AuthConfigResponse">;
export type AdminAuthSettingsResponse = ApiSchema<"AdminAuthSettingsResponse">;
export type IdentityProvider = ApiSchema<"IdentityProviderResponse">;
export type ExternalGitProvider = ApiSchema<"ExternalGitProviderResponse">;
export type AuthUser = ApiSchema<"AuthMeResponse">;
export type LocalLoginInput = ApiSchema<"LocalLoginInput">;
export type LocalRegisterInput = ApiSchema<"LocalRegisterInput">;
export type AdminAuthSettings = ApiSchema<"AuthSettings"> & {
  managed_fields: string[];
};

export type ExternalGitConnectionStatus =
  ApiSchema<"ExternalRepositoryConnectionStatus">;
export type ExternalGitFailureCode = ApiSchema<"ExternalGitFailureCode">;
export type RepositoryOwner = ApiSchema<"RepositoryOwner">;
export type ExternalGitRepositoryOwnerListResponse =
  ApiSchema<"ExternalGitRepositoryOwnerListResponse">;
export type RemoteRepository = ApiSchema<"RemoteRepository">;
export type ExternalGitRepositoryListResponse =
  ApiSchema<"ExternalGitRepositoryListResponse">;
export type RemoteBranch = ApiSchema<"RemoteBranch">;
export type ExternalGitBranchListResponse = ApiSchema<"ExternalGitBranchListResponse">;
export type ExternalGitInboundJob = ApiSchema<"ExternalRepositoryInboundJob">;
export type ExternalGitProjectLinkStatus =
  ApiSchema<"ExternalRepositoryProjectStatus">;
export type ExternalGitProjectLinkMutation =
  ApiSchema<"ExternalGitProjectLinkMutationResponse">;
export type ExternalGitCheckpointResponse =
  ApiSchema<"ExternalGitCheckpointResponse">;

export type ProjectShareLink = ApiSchema<"ProjectShareLink">;
export type CreateProjectShareLinkResponse =
  ApiSchema<"CreateProjectShareLinkResponse">;
export type JoinProjectShareLinkResponse =
  ApiSchema<"JoinProjectShareLinkResponse">;
export type ResolveProjectShareLinkResponse =
  ApiSchema<"ResolveProjectShareLinkResponse">;
export type TemporaryShareLoginResponse = ApiSchema<"TemporaryShareLoginResponse">;
export type ProjectOrganizationAccess = ApiSchema<"ProjectOrganizationAccess">;
export type ProjectAccessSource = ApiSchema<"ProjectAccessSource">;
export type ProjectAccessUser = ApiSchema<"ProjectAccessUser">;
export type ProjectAccessUserListResponse =
  ApiSchema<"ProjectAccessUserListResponse">;
export type ProjectRoleBinding = ApiSchema<"ProjectRoleBinding">;
export type ProjectGroupRoleBinding = ApiSchema<"ProjectGroupRoleBinding">;

export type CreateProjectInput = ApiSchema<"CreateProjectInput">;
export type CreateProjectCopyInput = ApiSchema<"CreateProjectCopyInput">;
export type CreateBuiltinTemplateProjectInput =
  ApiSchema<"CreateBuiltinTemplateProjectInput">;
export type UpdateProjectNameInput = ApiSchema<"UpdateProjectNameInput">;
export type UpdateProjectArchivedInput = ApiSchema<"UpdateProjectArchivedInput">;
export type CreateProjectFileInput = ApiSchema<"CreateProjectFileInput">;
export type MoveProjectFileInput = ApiSchema<"MoveProjectFileInput">;
export type UpdateProjectEntryFileInput = ApiSchema<"UpdateProjectEntryFileInput">;
export type UpdateProjectLatexEngineInput = ApiSchema<"UpdateProjectLatexEngineInput">;
export type UpdateProjectTemplateInput = ApiSchema<"UpdateProjectTemplateInput">;
export type UploadProjectThumbnailInput = ApiSchema<"UploadProjectThumbnailInput">;
export type CreateDocumentInput = ApiSchema<"CreateDocumentInput">;
export type UpdateDocumentInput = ApiSchema<"UpdateDocumentInput">;
export type UpsertDocumentByPathInput = ApiSchema<"UpsertDocumentByPathInput">;
export type UploadAssetInput = ApiSchema<"UploadAssetInput">;
export type UploadPdfArtifactInput = ApiSchema<"UploadPdfArtifactInput">;
export type CreateRevisionInput = ApiSchema<"CreateRevisionInput">;
export type CreateExternalGitImportInput = ApiSchema<"CreateExternalGitImportInput">;
export type RequestExternalGitInboundSyncInput =
  ApiSchema<"RequestExternalGitInboundSyncInput">;
export type CreateExternalGitRepositoryInput =
  ApiSchema<"CreateExternalGitRepositoryInput">;
export type LinkExternalGitRepositoryInput =
  ApiSchema<"LinkExternalGitRepositoryInput">;
export type CreateProjectShareLinkInput =
  ApiSchema<"CreateProjectShareLinkInput">;
export type TemporaryShareLoginInput = ApiSchema<"TemporaryShareLoginInput">;
export type UpsertProjectOrganizationAccessInput =
  ApiSchema<"UpsertProjectOrganizationAccessInput">;
export type CreatePatInput = ApiSchema<"CreatePatInput">;
export type UpsertOrgGroupRoleMappingInput =
  ApiSchema<"UpsertOrgGroupRoleMappingInput">;
export type UpsertAdminAuthSettingsInput =
  ApiSchema<"UpsertAdminAuthSettingsInput">;

export type RealtimeClientMessage = ApiSchema<"RealtimeClientMessage">;
export type RealtimeServerEvent = ApiSchema<"RealtimeServerEvent">;
export type RealtimeServerEventKind = ApiSchema<"RealtimeServerEventKind">;
export type RealtimeMetadataPayload = ApiSchema<"RealtimeMetadataPayload">;
export type RealtimeCursorPayload = ApiSchema<"RealtimeCursorPayload">;
export type RealtimeWorkspaceChangedPayload =
  ApiSchema<"RealtimeWorkspaceChangedPayload">;
export type RealtimeWorkspaceChangeScope =
  ApiSchema<"RealtimeWorkspaceChangeScope">;
