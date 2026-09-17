# Contributing

## Development

```sh
npm install
npm run build
npm test
```

The tests run without a lamp. The handshake crypto is pinned against vectors
generated from the Python reference implementation, the decision modules
(reconciliation, queueing, debouncing, settling) are tested directly, and the
built plugin is loaded the way Homebridge loads it.

To try a change on real hardware, install the packed tarball into the Homebridge
storage directory rather than npm's global prefix:

```sh
npm pack
scp homebridge-dyson-solarcycle-morph-*.tgz <host>:/tmp/
# on the Homebridge host:
cd /var/lib/homebridge
sudo -u homebridge /opt/homebridge/bin/npm install /tmp/homebridge-dyson-solarcycle-morph-*.tgz
sudo systemctl restart homebridge
```

## Releasing

Publishing runs from GitHub Actions using [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is
stored in the repository and there is none to rotate.

**One-time setup on npmjs.com**, under the package's *Settings → Trusted
publisher*:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `rummeyer` |
| Repository | `homebridge-dyson-solarcycle-morph` |
| Workflow filename | `publish.yml` |

Until that exists the publish workflow fails rather than falling back to
another method.

**To release:**

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag: `git tag v0.1.0 && git push --tags`.
3. Create a GitHub release for that tag.

The workflow checks the tag against `package.json` before publishing — a
mistagged release would otherwise put the wrong version under the right name,
which cannot be undone.
