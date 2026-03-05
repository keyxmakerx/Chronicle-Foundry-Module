// Package modules defines the module registry for Chronicle.
// Modules are game-system content packs (e.g., D&D 5e, Pathfinder) that
// provide reference data, tooltips, and stat blocks. They are read-only
// and enabled per campaign via campaign settings.
//
// The registry auto-discovers modules by scanning subdirectories for
// manifest.json files at startup. See ModuleManifest for the JSON spec.
package modules

import (
	"fmt"
	"log/slog"
)

// Status represents the implementation status of a module.
type Status string

const (
	// StatusAvailable means the module is fully implemented and ready to enable.
	StatusAvailable Status = "available"

	// StatusComingSoon means the module is planned but not yet implemented.
	StatusComingSoon Status = "coming_soon"
)

// globalLoader is the singleton module loader initialized by Init().
var globalLoader *ModuleLoader

// Init initializes the module registry by scanning the given directory
// for module subdirectories containing manifest.json files. Must be
// called once at application startup before any Registry()/Find() calls.
func Init(modulesDir string) error {
	globalLoader = NewModuleLoader(modulesDir)
	if err := globalLoader.DiscoverAll(); err != nil {
		return fmt.Errorf("module discovery failed: %w", err)
	}
	slog.Info("module registry initialized",
		slog.Int("count", globalLoader.Count()),
	)
	return nil
}

// Registry returns all discovered module manifests, sorted by name.
// Returns nil if Init() has not been called.
func Registry() []*ModuleManifest {
	if globalLoader == nil {
		return nil
	}
	return globalLoader.All()
}

// Find returns the manifest for a given module ID, or nil if not found.
// Returns nil if Init() has not been called.
func Find(id string) *ModuleManifest {
	if globalLoader == nil {
		return nil
	}
	return globalLoader.Get(id)
}
