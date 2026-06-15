# Azure DevOps Volt extension

Azure DevOps integration package for Volt.

## Install

From the Volt store:

```text
/store install azure-devops
```

Or install the package source directly:

```bash
volt install git:https://github.com/hansjm10/Volt@store/azure-devops
```

## Configure

Run `/ado-config` in Volt to open an interactive setup wizard for:

- organization
- default project
- auth mode
- optional tenant ID and app client ID for device-code auth
- optional save to `.volt/azure-devops.json`
- optional connection test

The project config file stores non-secret settings only. PATs and bearer tokens must stay in environment variables.

Non-interactive forms are also supported:

```text
/ado-config show
/ado-config save
/ado-config clear
/ado-config contoso MyProject device-code
/ado-config contoso MyProject device-code <tenant-id> <client-id>
```

You can also set environment variables before starting Volt:

```bash
VOLT_ADO_ORG=contoso
VOLT_ADO_PROJECT=MyProject
VOLT_ADO_AUTH=device-code
```

Auth modes:

- `device-code` (default): Microsoft Entra device code flow. For production, set `VOLT_ADO_CLIENT_ID` to your app registration client ID.
- `pat`: reads `VOLT_ADO_PAT` or `AZURE_DEVOPS_EXT_PAT`.
- `bearer`: reads `VOLT_ADO_TOKEN`.

Optional:

```bash
VOLT_ADO_TENANT_ID=<tenant-id>
VOLT_ADO_CLIENT_ID=<app-client-id>
```

## Commands

- `/ado-config`: open the interactive setup wizard.
- `/ado-config show`: show resolved config.
- `/ado-config save`: write resolved non-secret config to `.volt/azure-devops.json`.
- `/ado-config clear`: clear session config. Project config still applies if present.
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
