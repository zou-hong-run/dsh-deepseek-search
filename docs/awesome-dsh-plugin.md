# Submitting to awesome-dsh-plugin

The dsh-market catalogue (`dshmarket.com`, `awesome-dsh-plugin.com`) is generated from
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
so an entry there is what makes this plugin searchable in those markets. It is not crawled
from npm.

## The line to add

Under **Browser & Web** in `README.md`, matching the shape of the neighbouring entries
(two spaces, `*`, space, `owner/repo`, space, `\-`, space, description):

```markdown
  * zou-hong-run/dsh-deepseek-search \- DeepSeek Search / Fetch API providers for the DSH Web GUI: replaces both the web_search and web_fetch backends, with configurable retries, settings that apply to the next call, and a configuration page on the bundle page.
```

## Pull request

Title:

```text
Add zou-hong-run/dsh-deepseek-search
```

Body:

```markdown
## What it is

`dsh-deepseek-search` registers a search provider and a fetch provider on `ctx.web`, backed by
DeepSeek's Search and Fetch JSON APIs (`/v1/tools/search`, `/v1/tools/fetch`). The model-facing
`web_search` / `web_fetch` tools stay with `dsh-tool-web`; this plugin only supplies the two
backends, so it adds no tool definitions of its own.

## Why it installs

- npm: `dsh plugin --profile web add dsh-deepseek-search` (0.1.0 published)
- GitHub: `dsh plugin --profile web add github:zou-hong-run/dsh-deepseek-search`
- declares a `dsh.bundle` manifest with `engines.dsh: ^0.2.1-rc.5`
- no install scripts, one runtime dependency (`@deepseek-ai/schemastery`)
- verified on a real host: the providers activate and `web_search` / `web_fetch` return results

## Category

Browser & Web

## Checklist

- [x] installs with `dsh plugin add`
- [x] the one-line description matches what the code does
- [x] repository is maintained (0.1.0 released, README and tests in the repository)
```

## Before submitting

- The repository description on GitHub should name the plugin as `dsh-deepseek-search` and
  mention both install paths, so the npm name and the GitHub name do not look like two projects.
- Do not put checkable counts in the description ("N tools", "N engines") — reviewers verify them.
