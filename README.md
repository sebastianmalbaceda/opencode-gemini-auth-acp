# Gemini OAuth Plugin for Opencode

![License](https://img.shields.io/npm/l/opencode-gemini-auth)
![Version](https://img.shields.io/npm/v/opencode-gemini-auth)

> [!IMPORTANT]
> This plugin bridges Opencode with the **official Gemini CLI** (`@google/gemini-cli`).
> Unlike earlier versions, it does **not** hardcode OAuth credentials, impersonate
> the Gemini CLI, or distribute Google's client secrets. All authentication is
> handled by the official Gemini CLI that you install on your own machine.
>
> **You must install the Gemini CLI separately.** This plugin delegates all
> authentication and token management to the official CLI, which means your
> usage stays within Google's Terms of Service.

**Authenticate the Opencode CLI with your Google account.** This plugin enables
you to use your existing Gemini plan and quotas (including the free tier)
directly within Opencode.

## Prerequisites

- [Opencode CLI](https://opencode.ai) installed.
- A Google account with access to Gemini.
- **Gemini CLI** installed globally:

  ```bash
  npm install -g @google/gemini-cli
  ```

- Gemini CLI authenticated:

  ```bash
  gemini auth login
  ```

## Installation

Add the plugin to your Opencode configuration file
(`~/.config/opencode/opencode.json` or similar):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth@latest"]
}
```

> [!IMPORTANT]
> Explicitly configure a Google Cloud `projectId` if you're using an
> organization-backed Gemini Code Assist subscription
> (`Standard`/`Enterprise`) or a company, school, or Google Workspace account.
> Most individual Google accounts should not need this. `Google AI Plus` is not
> a Gemini Code Assist subscription tier. You can still set `projectId` to
> force a specific project.

## Usage

1. **Install & authenticate the Gemini CLI** (one-time setup):

   ```bash
   npm install -g @google/gemini-cli
   gemini auth login
   ```

2. **Login to Opencode**:

   ```bash
   opencode auth login
   ```

2. **Select Provider**: Choose **Google** from the list.
3. **Authenticate**: Select **OAuth with Google (Gemini CLI)**.
   - If the Gemini CLI is already authenticated, the plugin uses its credentials directly.
   - Otherwise, a browser window will open for you to approve the access.
   - The plugin spins up a temporary local server to capture the callback.
   - If the local server fails (e.g., port in use or headless environment),
     you can manually paste the callback URL or just the authorization code.

Once authenticated, Opencode will use your Google account for Gemini requests.

To check your current Gemini Code Assist quota buckets at any time, run:

```bash
/gquota
```

## Configuration

### Google Cloud Project

By default, the plugin attempts to provision or find a suitable Google Cloud
project. To force a specific project, set the `projectId` in your configuration
or via environment variables:

**File:** `~/.config/opencode/opencode.json`

```json
{
  "provider": {
    "google": {
      "options": {
        "projectId": "your-specific-project-id"
      }
    }
  }
}
```

You can also set `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or
`GOOGLE_CLOUD_PROJECT_ID` to supply the project ID via environment variables.

### Proxy

If your network requires an HTTP proxy for Google API calls, set
`OPENCODE_GEMINI_AUTH_PROXY` before starting Opencode:

```bash
OPENCODE_GEMINI_AUTH_PROXY=http://127.0.0.1:8080 opencode
```

This is passed to Bun's `fetch` proxy option and applies to OAuth, token
refresh, project/quota lookup, and Gemini request forwarding.

### Model list

If you want to remove unusable models from the picker, use OpenCode's
`provider.google.whitelist` or `provider.google.blacklist` settings.

- `whitelist`: only show the listed model IDs.
- `blacklist`: hide specific model IDs from the default list.
- `models`: define or override model metadata/options, but does not remove the
  default models by itself.

Use the exact model IDs reported by `opencode models google` when building these
lists.

Example: keep only a small Gemini model list visible.

```json
{
  "provider": {
    "google": {
      "whitelist": [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-3-flash-preview",
        "gemini-3-pro-preview"
      ]
    }
  }
}
```

Example: hide a few unwanted defaults while keeping the rest.

```json
{
  "provider": {
    "google": {
      "blacklist": [
        "gemini-2.0-flash-exp",
        "gemini-1.5-pro"
      ]
    }
  }
}
```

Below are example model entries you can add under `provider.google.models` in your
Opencode config. Each model can include an `options.thinkingConfig` block to
enable "thinking" features.

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-2.5-flash": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        },
        "gemini-2.5-pro": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        },
        "gemini-3-flash-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
        "gemini-3-pro-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        }
      }
    }
  }
}
```

Note: Available model names and previews may change—check Google's documentation or
the Gemini product page for the current model identifiers.

### Thinking Models

The plugin supports configuring Gemini "thinking" features per-model via
`thinkingConfig`. The available fields depend on the model family:

- For Gemini 3 models: use `thinkingLevel` with values `"low"` or `"high"`.
- For Gemini 2.5 models: use `thinkingBudget` (token count).
- `includeThoughts` (boolean) controls whether the model emits internal thoughts.

A combined example showing both model types:

```json
{
  "provider": {
    "google": {
      "models": {
        "gemini-3-pro-preview": {
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "high",
              "includeThoughts": true
            }
          }
        },
        "gemini-2.5-flash": {
          "options": {
            "thinkingConfig": {
              "thinkingBudget": 8192,
              "includeThoughts": true
            }
          }
        }
      }
    }
  }
}
```

If you don't set a `thinkingConfig` for a model, the plugin will use default
behavior for that model.

The plugin also accepts request payloads that put `thinkingConfig` at the root
and normalizes them into `generationConfig.thinkingConfig` before forwarding to
Gemini Code Assist.

## Troubleshooting

### Manual Google Cloud Setup

If automatic provisioning fails, you may need to set up the project manually:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Gemini for Google Cloud API**
   (`cloudaicompanion.googleapis.com`).
4. Configure the `projectId` in your Opencode config as shown above.

### Quotas, Plans, and 429 Errors

Common causes of `429 RESOURCE_EXHAUSTED` or `QUOTA_EXHAUSTED`:

- **No project ID configured**: the plugin uses a managed free-tier project, which has lower quotas.
- **Model-specific limits**: quotas are tracked per model (e.g., `gemini-3-pro-preview` vs `gemini-3-flash-preview`).
- **Large prompts**: OAuth/Code Assist does not support cached content, so long system prompts and history can burn quota quickly.
- **Parallel sessions**: multiple Opencode windows can drain the same bucket.

Notes:

- **Gemini CLI auto-fallbacks**: the official CLI may fall back to Flash when Pro quotas are exhausted, so it can appear to “work” even if the Pro bucket is depleted.
- **Org-backed Code Assist subscriptions require a project**: if you're using Gemini Code Assist `Standard` or `Enterprise`, set `provider.google.options.projectId` (or `OPENCODE_GEMINI_PROJECT_ID`) and re-authenticate.

### Debugging

To view detailed logs of Gemini requests and responses, set the
`OPENCODE_GEMINI_DEBUG` environment variable:

```bash
OPENCODE_GEMINI_DEBUG=1 opencode
```

This will generate `gemini-debug-<timestamp>.log` files in your working
directory containing sanitized request/response details.

## Architecture

This plugin uses the **Gemini CLI credential bridge** approach:

```
Opencode → Plugin → Direct HTTP (Gemini Code Assist API)
                     ↓
              Tokens from ~/.gemini/oauth_creds.json
                     ↓
              Official Gemini CLI handles OAuth
```

1. **Auth**: The user authenticates once with `gemini auth login` (official Gemini CLI)
2. **Credentials**: The plugin reads tokens from the CLI's credential store (`~/.gemini/oauth_creds.json`)
3. **OAuth app credentials**: For token refresh, the plugin extracts the OAuth client
   credentials from the locally installed `@google/gemini-cli` package
4. **API calls**: The plugin makes direct HTTP calls to Gemini Code Assist endpoints
   using the tokens — the same pipeline as the original plugin, but without
   hardcoded secrets or user-agent impersonation

Unlike the original plugin, this version does NOT:
- ❌ Hardcode `client_id` or `client_secret` in source code
- ❌ Impersonate the Gemini CLI user-agent
- ❌ Store or distribute Google's OAuth credentials

### References

- Gemini CLI repository: https://github.com/google-gemini/gemini-cli
- Gemini CLI npm package: `@google/gemini-cli`
- Gemini CLI quota documentation: https://developers.google.com/gemini-code-assist/resources/quotas

### Updating

Opencode does not automatically update plugins. To update to the latest version,
you must clear the cached plugin:

```bash
# Clear the specific plugin cache
rm -rf ~/.cache/opencode/node_modules/opencode-gemini-auth

# Run Opencode to trigger a fresh install
opencode
```

## Development

To develop on this plugin locally:

1. **Clone**:

   ```bash
   git clone https://github.com/jenslys/opencode-gemini-auth.git
   cd opencode-gemini-auth
   bun install
   ```

2. **Link**:
   Update your Opencode config to point to your local directory using a
   `file://` URL:

   ```json
   {
     "plugin": ["file:///absolute/path/to/opencode-gemini-auth"]
   }
   ```

## License

MIT
