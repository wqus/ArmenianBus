export function actionLinkToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')
  return params.size === 1 &&
    params.getAll('token').length === 1 &&
    token !== null &&
    /^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(token)
    ? token
    : null
}
