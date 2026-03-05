package modules

import (
	"log/slog"
	"os"
	"path/filepath"
	"sort"
)

// ModuleLoader discovers and loads module manifests from a directory tree.
// Each subdirectory containing a manifest.json is treated as a module.
// Invalid manifests are logged as warnings but do not prevent startup.
type ModuleLoader struct {
	modulesDir string
	modules    map[string]*loadedModule
}

// loadedModule pairs a parsed manifest with its source directory path.
type loadedModule struct {
	manifest *ModuleManifest
	dir      string
}

// NewModuleLoader creates a loader that will scan the given directory
// for module subdirectories containing manifest.json files.
func NewModuleLoader(modulesDir string) *ModuleLoader {
	return &ModuleLoader{
		modulesDir: modulesDir,
		modules:    make(map[string]*loadedModule),
	}
}

// DiscoverAll scans the modules directory for subdirectories containing
// manifest.json files. Each valid manifest is loaded and registered.
// Invalid manifests are logged as warnings but do not cause an error.
// Returns an error only if the modules directory itself cannot be read.
func (l *ModuleLoader) DiscoverAll() error {
	entries, err := os.ReadDir(l.modulesDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		manifestPath := filepath.Join(l.modulesDir, entry.Name(), "manifest.json")
		if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
			continue
		}

		manifest, err := LoadManifest(manifestPath)
		if err != nil {
			slog.Warn("skipping invalid module manifest",
				slog.String("dir", entry.Name()),
				slog.String("error", err.Error()),
			)
			continue
		}

		l.modules[manifest.ID] = &loadedModule{
			manifest: manifest,
			dir:      filepath.Join(l.modulesDir, entry.Name()),
		}

		slog.Info("discovered module",
			slog.String("id", manifest.ID),
			slog.String("name", manifest.Name),
			slog.String("version", manifest.Version),
			slog.String("status", string(manifest.Status)),
		)
	}

	return nil
}

// Get returns the manifest for a module by ID, or nil if not found.
func (l *ModuleLoader) Get(id string) *ModuleManifest {
	if lm, ok := l.modules[id]; ok {
		return lm.manifest
	}
	return nil
}

// All returns all discovered module manifests, sorted alphabetically by name.
func (l *ModuleLoader) All() []*ModuleManifest {
	result := make([]*ModuleManifest, 0, len(l.modules))
	for _, lm := range l.modules {
		result = append(result, lm.manifest)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result
}

// Dir returns the absolute directory path for a module by ID, or empty string.
func (l *ModuleLoader) Dir(id string) string {
	if lm, ok := l.modules[id]; ok {
		return lm.dir
	}
	return ""
}

// Count returns the number of discovered modules.
func (l *ModuleLoader) Count() int {
	return len(l.modules)
}
