export type WorkspaceFeatureAvailability = {
  projectAccess: boolean;
  revisions: boolean;
  externalRepositories: boolean;
  backgroundProcessing: boolean;
  accountControls: boolean;
};

export const coreWorkspaceFeatureAvailability: WorkspaceFeatureAvailability = {
  projectAccess: true,
  revisions: true,
  externalRepositories: true,
  backgroundProcessing: true,
  accountControls: true,
};

export const browserWorkspaceFeatureAvailability: WorkspaceFeatureAvailability = {
  projectAccess: false,
  revisions: false,
  externalRepositories: false,
  backgroundProcessing: false,
  accountControls: false,
};
