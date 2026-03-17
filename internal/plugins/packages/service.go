package packages

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// PackageService handles business logic for package management.
// It coordinates between the repository (database), GitHub API client,
// and the local filesystem to manage installed package versions.
type PackageService interface {
	// Package CRUD
	ListPackages(ctx context.Context) ([]Package, error)
	GetPackage(ctx context.Context, id string) (*Package, error)
	AddPackage(ctx context.Context, input AddPackageInput) (*Package, error)
	RemovePackage(ctx context.Context, id string) error

	// Version management
	CheckForUpdates(ctx context.Context, packageID string) ([]PackageVersion, error)
	CheckAllForUpdates(ctx context.Context) error
	ListVersions(ctx context.Context, packageID string) ([]PackageVersion, error)
	InstallVersion(ctx context.Context, packageID, version string) error
	SetPinnedVersion(ctx context.Context, packageID, version string) error
	ClearPinnedVersion(ctx context.Context, packageID string) error
	SetAutoUpdate(ctx context.Context, packageID string, policy UpdatePolicy) error

	// Usage tracking
	GetUsage(ctx context.Context, packageID string) ([]PackageUsage, error)

	// Auto-update worker
	RunAutoUpdates(ctx context.Context) error

	// StartAutoUpdateWorker runs a background loop that checks for updates hourly.
	StartAutoUpdateWorker(ctx context.Context)

	// FoundryModulePath returns the install path for the active Foundry module,
	// or empty string if none is installed.
	FoundryModulePath() string
}

// packageService implements PackageService.
type packageService struct {
	repo     PackageRepository
	github   *GitHubClient
	mediaDir string // Root media directory (e.g., ./media).
}

// NewPackageService creates a new package service with the given dependencies.
func NewPackageService(repo PackageRepository, github *GitHubClient, mediaDir string) PackageService {
	return &packageService{
		repo:     repo,
		github:   github,
		mediaDir: mediaDir,
	}
}

// packagesDir returns the root directory for package storage.
func (s *packageService) packagesDir() string {
	return filepath.Join(s.mediaDir, "packages")
}

// downloadsDir returns the directory for cached ZIP downloads.
func (s *packageService) downloadsDir() string {
	return filepath.Join(s.packagesDir(), "downloads")
}

// installDir returns the extraction directory for a package version.
func (s *packageService) installDir(pkgType PackageType, slug, version string) string {
	switch pkgType {
	case PackageTypeFoundryModule:
		return filepath.Join(s.packagesDir(), "foundry-module", version)
	default:
		return filepath.Join(s.packagesDir(), "systems", slug, version)
	}
}

// ListPackages returns all registered packages.
func (s *packageService) ListPackages(ctx context.Context) ([]Package, error) {
	return s.repo.ListPackages(ctx)
}

// GetPackage returns a single package by ID.
func (s *packageService) GetPackage(ctx context.Context, id string) (*Package, error) {
	return s.repo.GetPackage(ctx, id)
}

// AddPackage registers a new GitHub repository as a package, fetches its
// releases, and optionally installs the latest version.
func (s *packageService) AddPackage(ctx context.Context, input AddPackageInput) (*Package, error) {
	repoURL := strings.TrimSpace(input.RepoURL)
	if repoURL == "" {
		return nil, fmt.Errorf("repository URL is required")
	}

	// Verify the URL is parseable as a GitHub repo.
	_, _, err := parseRepo(repoURL)
	if err != nil {
		return nil, fmt.Errorf("invalid GitHub repository URL: %w", err)
	}

	// Check for duplicates.
	existing, err := s.repo.FindByRepoURL(ctx, repoURL)
	if err != nil {
		return nil, fmt.Errorf("checking for duplicate: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("package already registered: %s", existing.Name)
	}

	// Determine package type from input or infer later.
	pkgType := PackageType(input.Type)
	if pkgType == "" {
		pkgType = PackageTypeSystem // Default to system.
	}

	// Generate slug from repo name.
	owner, repo, _ := parseRepo(repoURL)
	slug := repo
	name := input.Name
	if name == "" {
		name = repo
	}

	now := time.Now()
	pkg := &Package{
		ID:            generateUUID(),
		Type:          pkgType,
		Slug:          slug,
		Name:          name,
		RepoURL:       repoURL,
		Description:   fmt.Sprintf("Package from %s/%s", owner, repo),
		AutoUpdate:    UpdateNightly,
		LastCheckedAt: &now,
	}

	if err := s.repo.CreatePackage(ctx, pkg); err != nil {
		return nil, fmt.Errorf("creating package record: %w", err)
	}

	// Fetch releases from GitHub and import versions.
	newVersions, err := s.fetchAndImportVersions(ctx, pkg)
	if err != nil {
		slog.Warn("failed to fetch initial releases",
			slog.String("package", pkg.Slug),
			slog.Any("error", err),
		)
		// Non-fatal: the package is still registered, releases can be fetched later.
		return pkg, nil
	}

	// Auto-install the latest version if available.
	if len(newVersions) > 0 {
		latest := newVersions[0]
		if err := s.InstallVersion(ctx, pkg.ID, latest.Version); err != nil {
			slog.Warn("failed to auto-install latest version",
				slog.String("package", pkg.Slug),
				slog.String("version", latest.Version),
				slog.Any("error", err),
			)
		}
	}

	// Re-fetch to get updated state.
	return s.repo.GetPackage(ctx, pkg.ID)
}

// RemovePackage deletes a package and cleans up its installed files.
func (s *packageService) RemovePackage(ctx context.Context, id string) error {
	pkg, err := s.repo.GetPackage(ctx, id)
	if err != nil {
		return fmt.Errorf("fetching package: %w", err)
	}
	if pkg == nil {
		return fmt.Errorf("package not found")
	}

	// Remove installed files from disk.
	if pkg.InstallPath != "" {
		if err := os.RemoveAll(pkg.InstallPath); err != nil {
			slog.Warn("failed to remove package files",
				slog.String("package", pkg.Slug),
				slog.String("path", pkg.InstallPath),
				slog.Any("error", err),
			)
		}
	}

	// Delete from database (CASCADE will remove versions too).
	if err := s.repo.DeletePackage(ctx, id); err != nil {
		return fmt.Errorf("deleting package: %w", err)
	}

	slog.Info("package removed",
		slog.String("id", id),
		slog.String("slug", pkg.Slug),
	)
	return nil
}

// CheckForUpdates fetches new releases from GitHub for a single package
// and imports any new versions. Returns the list of newly discovered versions.
func (s *packageService) CheckForUpdates(ctx context.Context, packageID string) ([]PackageVersion, error) {
	pkg, err := s.repo.GetPackage(ctx, packageID)
	if err != nil {
		return nil, fmt.Errorf("fetching package: %w", err)
	}
	if pkg == nil {
		return nil, fmt.Errorf("package not found")
	}

	return s.fetchAndImportVersions(ctx, pkg)
}

// CheckAllForUpdates fetches releases for all registered packages.
func (s *packageService) CheckAllForUpdates(ctx context.Context) error {
	packages, err := s.repo.ListPackages(ctx)
	if err != nil {
		return fmt.Errorf("listing packages: %w", err)
	}

	for i := range packages {
		if _, err := s.fetchAndImportVersions(ctx, &packages[i]); err != nil {
			slog.Warn("failed to check for updates",
				slog.String("package", packages[i].Slug),
				slog.Any("error", err),
			)
		}
	}
	return nil
}

// ListVersions returns all known versions for a package, newest first.
func (s *packageService) ListVersions(ctx context.Context, packageID string) ([]PackageVersion, error) {
	return s.repo.ListVersions(ctx, packageID)
}

// InstallVersion downloads and extracts a specific version of a package.
func (s *packageService) InstallVersion(ctx context.Context, packageID, version string) error {
	pkg, err := s.repo.GetPackage(ctx, packageID)
	if err != nil {
		return fmt.Errorf("fetching package: %w", err)
	}
	if pkg == nil {
		return fmt.Errorf("package not found")
	}

	ver, err := s.repo.GetVersion(ctx, packageID, version)
	if err != nil {
		return fmt.Errorf("fetching version: %w", err)
	}
	if ver == nil {
		return fmt.Errorf("version %s not found for package %s", version, pkg.Slug)
	}

	if ver.DownloadURL == "" {
		return fmt.Errorf("no download URL for version %s", version)
	}

	// Ensure directories exist.
	dlDir := s.downloadsDir()
	if err := os.MkdirAll(dlDir, 0o755); err != nil {
		return fmt.Errorf("creating downloads directory: %w", err)
	}

	destDir := s.installDir(pkg.Type, pkg.Slug, version)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return fmt.Errorf("creating install directory: %w", err)
	}

	// Download the ZIP.
	zipName := fmt.Sprintf("%s-%s.zip", pkg.Slug, version)
	zipPath := filepath.Join(dlDir, zipName)
	_, err = s.github.DownloadAsset(ctx, ver.DownloadURL, zipPath)
	if err != nil {
		return fmt.Errorf("downloading version %s: %w", version, err)
	}

	// Extract the ZIP to the install directory.
	if err := extractZip(zipPath, destDir); err != nil {
		_ = os.RemoveAll(destDir)
		return fmt.Errorf("extracting version %s: %w", version, err)
	}

	// Mark version as downloaded.
	if err := s.repo.MarkVersionDownloaded(ctx, ver.ID); err != nil {
		slog.Warn("failed to mark version as downloaded",
			slog.String("version_id", ver.ID),
			slog.Any("error", err),
		)
	}

	// Update the package with installed version and path.
	now := time.Now()
	pkg.InstalledVersion = version
	pkg.InstallPath = destDir
	pkg.LastInstalledAt = &now
	if err := s.repo.UpdatePackage(ctx, pkg); err != nil {
		return fmt.Errorf("updating package record: %w", err)
	}

	slog.Info("package version installed",
		slog.String("package", pkg.Slug),
		slog.String("version", version),
		slog.String("path", destDir),
	)
	return nil
}

// SetPinnedVersion pins a package to a specific version, preventing auto-updates.
func (s *packageService) SetPinnedVersion(ctx context.Context, packageID, version string) error {
	pkg, err := s.repo.GetPackage(ctx, packageID)
	if err != nil {
		return fmt.Errorf("fetching package: %w", err)
	}
	if pkg == nil {
		return fmt.Errorf("package not found")
	}

	// Verify the version exists.
	ver, err := s.repo.GetVersion(ctx, packageID, version)
	if err != nil {
		return fmt.Errorf("fetching version: %w", err)
	}
	if ver == nil {
		return fmt.Errorf("version %s not found", version)
	}

	pkg.PinnedVersion = version
	return s.repo.UpdatePackage(ctx, pkg)
}

// ClearPinnedVersion removes the version pin, allowing auto-updates again.
func (s *packageService) ClearPinnedVersion(ctx context.Context, packageID string) error {
	pkg, err := s.repo.GetPackage(ctx, packageID)
	if err != nil {
		return fmt.Errorf("fetching package: %w", err)
	}
	if pkg == nil {
		return fmt.Errorf("package not found")
	}

	pkg.PinnedVersion = ""
	return s.repo.UpdatePackage(ctx, pkg)
}

// SetAutoUpdate changes the auto-update policy for a package.
func (s *packageService) SetAutoUpdate(ctx context.Context, packageID string, policy UpdatePolicy) error {
	pkg, err := s.repo.GetPackage(ctx, packageID)
	if err != nil {
		return fmt.Errorf("fetching package: %w", err)
	}
	if pkg == nil {
		return fmt.Errorf("package not found")
	}

	pkg.AutoUpdate = policy
	return s.repo.UpdatePackage(ctx, pkg)
}

// GetUsage returns which campaigns are using a given package.
// Currently returns an empty list — full implementation requires querying
// campaign addon tables which will be wired in a future session.
func (s *packageService) GetUsage(ctx context.Context, packageID string) ([]PackageUsage, error) {
	// TODO: query campaign_addons / campaign_systems tables to find usage.
	return []PackageUsage{}, nil
}

// RunAutoUpdates checks all packages with auto-update enabled and installs
// new versions according to their update policy schedule.
func (s *packageService) RunAutoUpdates(ctx context.Context) error {
	packages, err := s.repo.ListPackages(ctx)
	if err != nil {
		return fmt.Errorf("listing packages: %w", err)
	}

	now := time.Now()
	for i := range packages {
		pkg := &packages[i]

		// Skip pinned packages.
		if pkg.PinnedVersion != "" {
			continue
		}

		shouldCheck := false
		switch pkg.AutoUpdate {
		case UpdateNightly:
			shouldCheck = pkg.LastCheckedAt == nil || now.Sub(*pkg.LastCheckedAt) >= 24*time.Hour
		case UpdateWeekly:
			shouldCheck = pkg.LastCheckedAt == nil || now.Sub(*pkg.LastCheckedAt) >= 7*24*time.Hour
		case UpdateOnRelease:
			shouldCheck = pkg.LastCheckedAt == nil || now.Sub(*pkg.LastCheckedAt) >= 1*time.Hour
		case UpdateOff:
			continue
		}

		if !shouldCheck {
			continue
		}

		newVersions, err := s.fetchAndImportVersions(ctx, pkg)
		if err != nil {
			slog.Warn("auto-update check failed",
				slog.String("package", pkg.Slug),
				slog.Any("error", err),
			)
			continue
		}

		if len(newVersions) > 0 {
			latest := newVersions[0]
			if latest.Version != pkg.InstalledVersion {
				if err := s.InstallVersion(ctx, pkg.ID, latest.Version); err != nil {
					slog.Warn("auto-update install failed",
						slog.String("package", pkg.Slug),
						slog.String("version", latest.Version),
						slog.Any("error", err),
					)
				} else {
					slog.Info("auto-updated package",
						slog.String("package", pkg.Slug),
						slog.String("from", pkg.InstalledVersion),
						slog.String("to", latest.Version),
					)
				}
			}
		}
	}
	return nil
}

// StartAutoUpdateWorker runs a background loop that checks for updates hourly.
// It blocks until the context is cancelled.
func (s *packageService) StartAutoUpdateWorker(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	slog.Info("package auto-update worker started")

	for {
		select {
		case <-ctx.Done():
			slog.Info("package auto-update worker stopped")
			return
		case <-ticker.C:
			if err := s.RunAutoUpdates(ctx); err != nil {
				slog.Error("auto-update run failed", slog.Any("error", err))
			}
		}
	}
}

// FoundryModulePath returns the install path for the active Foundry module
// package, or empty string if none is installed.
func (s *packageService) FoundryModulePath() string {
	ctx := context.Background()
	packages, err := s.repo.ListPackages(ctx)
	if err != nil {
		return ""
	}
	for _, pkg := range packages {
		if pkg.Type == PackageTypeFoundryModule && pkg.InstallPath != "" {
			return pkg.InstallPath
		}
	}
	return ""
}

// fetchAndImportVersions fetches releases from GitHub and upserts them into
// the database. Returns all versions sorted by published_at descending.
func (s *packageService) fetchAndImportVersions(ctx context.Context, pkg *Package) ([]PackageVersion, error) {
	releases, err := s.github.ListReleases(ctx, pkg.RepoURL)
	if err != nil {
		return nil, fmt.Errorf("fetching releases from GitHub: %w", err)
	}

	var versions []PackageVersion
	for _, rel := range releases {
		// Find the best download asset (prefer .zip files).
		downloadURL, fileSize := pickDownloadAsset(rel.Assets)

		v := PackageVersion{
			ID:           generateUUID(),
			PackageID:    pkg.ID,
			Version:      normalizeVersion(rel.TagName),
			TagName:      rel.TagName,
			ReleaseURL:   fmt.Sprintf("https://github.com/%s/releases/tag/%s", repoPath(pkg.RepoURL), rel.TagName),
			DownloadURL:  downloadURL,
			ReleaseNotes: rel.Body,
			PublishedAt:  rel.PublishedAt,
			FileSize:     fileSize,
		}

		if err := s.repo.UpsertVersion(ctx, &v); err != nil {
			slog.Warn("failed to upsert version",
				slog.String("package", pkg.Slug),
				slog.String("version", v.Version),
				slog.Any("error", err),
			)
			continue
		}
		versions = append(versions, v)
	}

	// Update last checked timestamp.
	now := time.Now()
	pkg.LastCheckedAt = &now
	if err := s.repo.UpdatePackage(ctx, pkg); err != nil {
		slog.Warn("failed to update last_checked_at",
			slog.String("package", pkg.Slug),
			slog.Any("error", err),
		)
	}

	return versions, nil
}

// pickDownloadAsset selects the best download URL from a release's assets.
// Prefers ZIP files, falls back to the first asset, or uses the zipball URL.
func pickDownloadAsset(assets []GitHubAsset) (url string, size int64) {
	// Prefer .zip files.
	for _, a := range assets {
		if strings.HasSuffix(strings.ToLower(a.Name), ".zip") {
			return a.BrowserDownloadURL, a.Size
		}
	}
	// Fall back to the first asset.
	if len(assets) > 0 {
		return assets[0].BrowserDownloadURL, assets[0].Size
	}
	return "", 0
}

// normalizeVersion strips a leading "v" from tag names (e.g., "v1.2.3" → "1.2.3").
func normalizeVersion(tag string) string {
	return strings.TrimPrefix(tag, "v")
}

// repoPath extracts "owner/repo" from a GitHub URL for constructing URLs.
func repoPath(repoURL string) string {
	owner, repo, err := parseRepo(repoURL)
	if err != nil {
		return ""
	}
	return owner + "/" + repo
}

// extractZip extracts a ZIP file to a destination directory.
func extractZip(zipPath, destDir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("opening zip: %w", err)
	}
	defer zr.Close()

	for _, zf := range zr.File {
		// Security: reject path traversal.
		if strings.Contains(zf.Name, "..") {
			return fmt.Errorf("invalid path in zip: %s", zf.Name)
		}

		destPath := filepath.Join(destDir, zf.Name)

		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(destPath, 0o755); err != nil {
				return fmt.Errorf("creating directory %s: %w", destPath, err)
			}
			continue
		}

		// Ensure parent directory exists.
		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return fmt.Errorf("creating parent dir: %w", err)
		}

		if err := extractSingleFile(zf, destPath); err != nil {
			return err
		}
	}
	return nil
}

// extractSingleFile extracts one file from the ZIP archive to disk.
func extractSingleFile(zf *zip.File, destPath string) error {
	rc, err := zf.Open()
	if err != nil {
		return fmt.Errorf("opening %s in zip: %w", zf.Name, err)
	}
	defer rc.Close()

	out, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("creating %s: %w", destPath, err)
	}
	defer out.Close()

	if _, err := io.Copy(out, rc); err != nil {
		return fmt.Errorf("writing %s: %w", destPath, err)
	}
	return nil
}
