// campaign_modules.go manages per-campaign custom game system modules.
// Campaign owners can upload ZIP files containing manifest.json + data/*.json
// to create custom reference content for their campaign. These modules use
// GenericModule (no Go code needed) and are stored in the media directory.
package modules

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// maxModuleZipSize limits custom module ZIP uploads to 50 MB.
const maxModuleZipSize = 50 * 1024 * 1024

// maxDataFileSize limits individual JSON data files to 10 MB.
const maxDataFileSize = 10 * 1024 * 1024

// CampaignModuleManager manages custom game system modules uploaded by
// campaign owners. Each campaign can have at most one custom module.
// Modules are stored on disk and loaded into memory as GenericModule instances.
type CampaignModuleManager struct {
	mu       sync.RWMutex
	baseDir  string                    // Root storage dir (e.g., ./media/modules).
	modules  map[string]*GenericModule // campaignID → loaded module instance.
	manifests map[string]*ModuleManifest // campaignID → manifest (even if module failed to load).
}

// NewCampaignModuleManager creates a manager that stores custom modules
// under baseDir/<campaignID>/. Discovers and loads any existing modules.
func NewCampaignModuleManager(baseDir string) *CampaignModuleManager {
	mgr := &CampaignModuleManager{
		baseDir:   baseDir,
		modules:   make(map[string]*GenericModule),
		manifests: make(map[string]*ModuleManifest),
	}

	// Discover existing uploads on startup.
	mgr.discoverAll()

	return mgr
}

// GetModule returns the custom module for a campaign, or nil if none.
func (m *CampaignModuleManager) GetModule(campaignID string) Module {
	m.mu.RLock()
	defer m.mu.RUnlock()
	mod := m.modules[campaignID]
	if mod == nil {
		return nil
	}
	return mod
}

// GetManifest returns the custom module manifest for a campaign, or nil.
func (m *CampaignModuleManager) GetManifest(campaignID string) *ModuleManifest {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.manifests[campaignID]
}

// Install extracts a ZIP file containing a custom game system module,
// validates it, stores it on disk, and loads it into memory.
// Returns the parsed manifest on success.
func (m *CampaignModuleManager) Install(campaignID string, zipData io.ReaderAt, zipSize int64) (*ModuleManifest, error) {
	if zipSize > maxModuleZipSize {
		return nil, fmt.Errorf("module ZIP exceeds maximum size of %d MB", maxModuleZipSize/(1024*1024))
	}

	zr, err := zip.NewReader(zipData, zipSize)
	if err != nil {
		return nil, fmt.Errorf("invalid ZIP file: %w", err)
	}

	// First pass: validate structure and find manifest.
	var manifestFile *zip.File
	var dataFiles []*zip.File
	for _, f := range zr.File {
		// Security: reject path traversal.
		if strings.Contains(f.Name, "..") {
			return nil, fmt.Errorf("invalid file path: %s", f.Name)
		}
		// Skip directories.
		if f.FileInfo().IsDir() {
			continue
		}
		if f.Name == "manifest.json" {
			manifestFile = f
		} else if strings.HasPrefix(f.Name, "data/") && strings.HasSuffix(f.Name, ".json") {
			if f.UncompressedSize64 > maxDataFileSize {
				return nil, fmt.Errorf("data file %s exceeds maximum size of %d MB", f.Name, maxDataFileSize/(1024*1024))
			}
			dataFiles = append(dataFiles, f)
		}
		// Ignore other files silently.
	}

	if manifestFile == nil {
		return nil, fmt.Errorf("ZIP must contain a manifest.json at the root")
	}
	if len(dataFiles) == 0 {
		return nil, fmt.Errorf("ZIP must contain at least one data/*.json file")
	}

	// Parse and validate manifest.
	manifest, err := m.readManifestFromZip(manifestFile)
	if err != nil {
		return nil, err
	}

	// Validate all data files parse as ReferenceItem arrays.
	for _, df := range dataFiles {
		if err := m.validateDataFile(df); err != nil {
			return nil, fmt.Errorf("invalid data file %s: %w", df.Name, err)
		}
	}

	// Prefix custom module ID to avoid collisions with built-in modules.
	if !strings.HasPrefix(manifest.ID, "custom-") {
		manifest.ID = "custom-" + manifest.ID
	}
	// Force status to available.
	manifest.Status = StatusAvailable

	// Remove any existing module for this campaign.
	m.removeFromDisk(campaignID)

	// Extract to disk.
	modDir := m.campaignModuleDir(campaignID)
	if err := os.MkdirAll(filepath.Join(modDir, "data"), 0o755); err != nil {
		return nil, fmt.Errorf("creating module directory: %w", err)
	}

	// Write modified manifest (with custom- prefix and available status).
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshaling manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(modDir, "manifest.json"), manifestBytes, 0o644); err != nil {
		return nil, fmt.Errorf("writing manifest: %w", err)
	}

	// Extract data files.
	for _, df := range dataFiles {
		destPath := filepath.Join(modDir, df.Name)
		if err := m.extractFile(df, destPath); err != nil {
			// Cleanup on failure.
			_ = os.RemoveAll(modDir)
			return nil, fmt.Errorf("extracting %s: %w", df.Name, err)
		}
	}

	// Load into memory.
	mod, err := NewGenericModule(manifest, filepath.Join(modDir, "data"))
	if err != nil {
		_ = os.RemoveAll(modDir)
		return nil, fmt.Errorf("loading module: %w", err)
	}

	m.mu.Lock()
	m.modules[campaignID] = mod
	m.manifests[campaignID] = manifest
	m.mu.Unlock()

	slog.Info("custom game system installed",
		slog.String("campaign_id", campaignID),
		slog.String("module_id", manifest.ID),
		slog.String("module_name", manifest.Name),
	)

	return manifest, nil
}

// Uninstall removes a campaign's custom game system from disk and memory.
func (m *CampaignModuleManager) Uninstall(campaignID string) error {
	m.mu.Lock()
	delete(m.modules, campaignID)
	delete(m.manifests, campaignID)
	m.mu.Unlock()

	m.removeFromDisk(campaignID)

	slog.Info("custom game system uninstalled",
		slog.String("campaign_id", campaignID),
	)
	return nil
}

// campaignModuleDir returns the storage path for a campaign's custom module.
func (m *CampaignModuleManager) campaignModuleDir(campaignID string) string {
	return filepath.Join(m.baseDir, campaignID)
}

// removeFromDisk deletes the campaign module directory.
func (m *CampaignModuleManager) removeFromDisk(campaignID string) {
	dir := m.campaignModuleDir(campaignID)
	if err := os.RemoveAll(dir); err != nil && !os.IsNotExist(err) {
		slog.Warn("failed to remove custom module directory",
			slog.String("dir", dir),
			slog.String("error", err.Error()),
		)
	}
}

// discoverAll scans the base directory for existing custom modules.
func (m *CampaignModuleManager) discoverAll() {
	entries, err := os.ReadDir(m.baseDir)
	if err != nil {
		// Directory doesn't exist yet — no custom modules.
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		campaignID := entry.Name()
		modDir := filepath.Join(m.baseDir, campaignID)
		manifestPath := filepath.Join(modDir, "manifest.json")

		manifest, err := LoadManifest(manifestPath)
		if err != nil {
			slog.Warn("skipping invalid custom module",
				slog.String("campaign_id", campaignID),
				slog.String("error", err.Error()),
			)
			continue
		}

		dataDir := filepath.Join(modDir, "data")
		mod, err := NewGenericModule(manifest, dataDir)
		if err != nil {
			slog.Warn("failed to load custom module",
				slog.String("campaign_id", campaignID),
				slog.String("error", err.Error()),
			)
			m.manifests[campaignID] = manifest
			continue
		}

		m.modules[campaignID] = mod
		m.manifests[campaignID] = manifest
		slog.Info("loaded custom game system",
			slog.String("campaign_id", campaignID),
			slog.String("module_id", manifest.ID),
		)
	}
}

// readManifestFromZip reads and validates a manifest from a ZIP entry.
func (m *CampaignModuleManager) readManifestFromZip(f *zip.File) (*ModuleManifest, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("opening manifest: %w", err)
	}
	defer func() { _ = rc.Close() }()

	data, err := io.ReadAll(io.LimitReader(rc, 1024*1024)) // 1 MB limit.
	if err != nil {
		return nil, fmt.Errorf("reading manifest: %w", err)
	}

	var manifest ModuleManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parsing manifest: %w", err)
	}

	if err := ValidateManifest(&manifest); err != nil {
		return nil, fmt.Errorf("invalid manifest: %w", err)
	}

	if len(manifest.Categories) == 0 {
		return nil, fmt.Errorf("manifest must define at least one category")
	}

	return &manifest, nil
}

// validateDataFile checks that a ZIP data file contains valid JSON
// that can be parsed as a ReferenceItem array.
func (m *CampaignModuleManager) validateDataFile(f *zip.File) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()

	data, err := io.ReadAll(io.LimitReader(rc, maxDataFileSize))
	if err != nil {
		return err
	}

	var items []ReferenceItem
	if err := json.Unmarshal(data, &items); err != nil {
		return fmt.Errorf("not a valid ReferenceItem array: %w", err)
	}

	if len(items) == 0 {
		return fmt.Errorf("data file is empty")
	}

	return nil
}

// extractFile writes a ZIP entry to disk.
func (m *CampaignModuleManager) extractFile(f *zip.File, destPath string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()

	out, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, io.LimitReader(rc, maxDataFileSize))
	return err
}
