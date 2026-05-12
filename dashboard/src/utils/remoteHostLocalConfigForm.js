export const EMPTY_REMOTE_HOST_CONFIG_FORM = {
  host: '',
  user: '',
  key_path: '',
  remote_project_path: '',
  remote_test_worktree_root: '',
  remote_test_worktree_subdir: '',
  lane_count: '1',
};

export function remoteConfigValuesToForm(remoteConfig) {
  const values = remoteConfig?.values || {};
  return {
    ...EMPTY_REMOTE_HOST_CONFIG_FORM,
    host: values.host || '',
    user: values.user || '',
    remote_project_path: values.remote_project_path || '',
    remote_test_worktree_root: values.remote_test_worktree_root || '',
    remote_test_worktree_subdir: values.remote_test_worktree_subdir || '',
    lane_count: values.lane_count ? String(values.lane_count) : '1',
  };
}

export function remoteConfigFormToPayload(form) {
  const payload = {};
  for (const [key, value] of Object.entries(form)) {
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed !== '') payload[key] = trimmed;
  }
  return payload;
}
