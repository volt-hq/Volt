# Azure DevOps Volt extension

Azure DevOps integration package for Volt.

## Install

From the Volt store:

```text
/store install azure-devops
```

Or install the package source directly:

```bash
volt install git:https://github.com/volt-hq/Volt@store/azure-devops
```

## Configure

The package's settings hold the non-secret configuration: edit them from `/extensions` (or `volt config`), or in `settings.json` under `extensions.azure-devops.settings`, globally or for a trusted project:

| Setting | Description |
|---------|-------------|
| `organization` | Azure DevOps organization (`dev.azure.com/<organization>`) |
| `project` | Default project for tools that take a project |
| `authMode` | `device-code`, `pat`, or `bearer`; empty picks `pat` or `bearer` when its variable is set, else `device-code` |
| `tenantId` | Tenant for device-code sign-in; empty uses the Azure SDK default |
| `clientId` | App registration for device-code sign-in; empty uses the Azure SDK default |

Settings are plain JSON, so PATs and bearer tokens must stay in environment variables. `.volt/azure-devops.json` is no longer read: move its values into the project settings (`/ado-config <org> [project] ...` then `/ado-config save` writes them there). The organization is letters, digits, and hyphens; the app client ID is a GUID.

Run `/ado-config` in Volt for a form with the organization, default project, auth mode, the optional tenant ID and app client ID for device-code auth, and where to keep them (this session, the global settings, or a trusted project's settings), followed by an optional connection test. Values that come from environment variables show as placeholders and are not stored.

Non-interactive forms are also supported:

```text
/ado-config show
/ado-config save [project|global]
/ado-config clear
/ado-config contoso MyProject device-code
/ado-config contoso MyProject device-code <tenant-id> <client-id>
```

Environment variables override the settings, and the session's values (from `/ado-config`) override both:

```bash
VOLT_ADO_ORG=contoso
VOLT_ADO_PROJECT=MyProject
VOLT_ADO_AUTH=device-code
```

Auth modes:

- `device-code` (default): Microsoft Entra device code flow; the code shows in a panel above the editor. For production, set `clientId` (or `VOLT_ADO_CLIENT_ID`) to your app registration client ID.
- `pat`: reads `VOLT_ADO_PAT` or `AZURE_DEVOPS_EXT_PAT`.
- `bearer`: reads `VOLT_ADO_TOKEN`.

Optional:

```bash
VOLT_ADO_TENANT_ID=<tenant-id>
VOLT_ADO_CLIENT_ID=<app-client-id>
```

## Commands

- `/ado-config`: open the setup form.
- `/ado-config show`: show resolved config.
- `/ado-config save [project|global]`: write the session's values over the current settings to the project (default) or global settings. Values from environment variables are not stored.
- `/ado-config clear`: clear session config. The settings still apply.
- `/ado-config <org> [project] [auth] [tenantId] [clientId]`: set session config from arguments.
- `/ado-status`: authenticate and list one project to validate access.

## Tools

Read-only tools:

- `ado_list_projects`
- `ado_list_teams`
- `ado_get_work_item`
- `ado_query_wiql`
- `ado_list_repos`
- `ado_list_pull_requests`
- `ado_get_pull_request`
