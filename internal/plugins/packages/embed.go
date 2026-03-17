// Package packages provides the package manager plugin for Chronicle.
// This file embeds the plugin's SQL migration files so they are available
// in the compiled binary regardless of the runtime working directory.
package packages

import "embed"

// MigrationsFS contains the embedded SQL migration files for the packages plugin.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS
