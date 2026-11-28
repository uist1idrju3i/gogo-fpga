#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '::error::%s\n' "$1" >&2
  exit 1
}

if [[ "${1:-}" != --environment-only ]]; then
  [[ "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF" == refs/tags/v* ]] ||
    fail "Expected a v* tag push"
  [[ "$(git cat-file -t "$GITHUB_REF")" == tag ]] ||
    fail "Expected an annotated tag"
  tag_name=$(git cat-file tag "$GITHUB_REF" | sed -n '3s/^tag //p')
  [[ "$tag_name" == "$GITHUB_REF_NAME" ]] || fail "Signed tag name does not match the ref"
  commit=$(git rev-parse "$GITHUB_REF^{commit}")
  [[ "$commit" == "$(git rev-parse HEAD)" &&
     "$commit" == "$(git rev-parse "$GITHUB_SHA^{commit}")" ]] ||
    fail "Tag, push event, and checkout must point to the same commit"
  git merge-base --is-ancestor "$commit" refs/remotes/origin/main ||
    fail "The tagged commit must be in main history"
  [[ -n "${RELEASE_TAG_PUBLIC_KEY:-}" ]] || fail "Configure RELEASE_TAG_PUBLIC_KEY first"
  export GNUPGHOME
  GNUPGHOME=$(mktemp -d)
  trap 'rm -rf -- "$GNUPGHOME"' EXIT
  printf '%s\n' "$RELEASE_TAG_PUBLIC_KEY" | gpg --batch --no-options --import
  git -c gpg.format=openpgp -c gpg.program=gpg verify-tag "$GITHUB_REF" ||
    fail "The tag must have a valid signature from a configured release key"
fi

endpoint="repos/$GITHUB_REPOSITORY/environments/production"
gh api "$endpoint" | jq -e '
  .can_admins_bypass == false and
  .deployment_branch_policy.protected_branches == false and
  .deployment_branch_policy.custom_branch_policies == true and
  any(.protection_rules[]; .type == "required_reviewers" and
    (.reviewers | type == "array" and length > 0))
' >/dev/null || fail "production must require reviewers and disallow administrator bypass"
gh api --paginate --slurp "$endpoint/deployment-branch-policies?per_page=100" | jq -e '
  length > 0 and
  all(.[]; .branch_policies | type == "array") and
  ([.[].branch_policies[] | {type, name}] == [{type: "tag", name: "v*"}])
' >/dev/null || fail "production must allow only the v* tag policy"
