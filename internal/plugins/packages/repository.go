package packages

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// PackageRepository handles database access for the packages plugin.
type PackageRepository interface {
	ListPackages(ctx context.Context) ([]Package, error)
	GetPackage(ctx context.Context, id string) (*Package, error)
	FindBySlug(ctx context.Context, slug string) (*Package, error)
	FindByRepoURL(ctx context.Context, repoURL string) (*Package, error)
	CreatePackage(ctx context.Context, pkg *Package) error
	UpdatePackage(ctx context.Context, pkg *Package) error
	DeletePackage(ctx context.Context, id string) error

	ListVersions(ctx context.Context, packageID string) ([]PackageVersion, error)
	GetVersion(ctx context.Context, packageID, version string) (*PackageVersion, error)
	UpsertVersion(ctx context.Context, v *PackageVersion) error
	MarkVersionDownloaded(ctx context.Context, id string) error
}

// packageRepository is the MariaDB implementation.
type packageRepository struct {
	db *sql.DB
}

// NewPackageRepository creates a repository backed by the given database.
func NewPackageRepository(db *sql.DB) PackageRepository {
	return &packageRepository{db: db}
}

// ListPackages returns all registered packages ordered by name.
func (r *packageRepository) ListPackages(ctx context.Context) ([]Package, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, type, slug, name, repo_url, COALESCE(description,''),
		       COALESCE(installed_version,''), COALESCE(pinned_version,''),
		       auto_update, last_checked_at, last_installed_at,
		       COALESCE(install_path,''), created_at, updated_at
		FROM packages ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("listing packages: %w", err)
	}
	defer rows.Close()

	var pkgs []Package
	for rows.Next() {
		var p Package
		if err := rows.Scan(&p.ID, &p.Type, &p.Slug, &p.Name, &p.RepoURL,
			&p.Description, &p.InstalledVersion, &p.PinnedVersion,
			&p.AutoUpdate, &p.LastCheckedAt, &p.LastInstalledAt,
			&p.InstallPath, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scanning package: %w", err)
		}
		pkgs = append(pkgs, p)
	}
	return pkgs, rows.Err()
}

// GetPackage returns a single package by ID, or nil if not found.
func (r *packageRepository) GetPackage(ctx context.Context, id string) (*Package, error) {
	var p Package
	err := r.db.QueryRowContext(ctx, `
		SELECT id, type, slug, name, repo_url, COALESCE(description,''),
		       COALESCE(installed_version,''), COALESCE(pinned_version,''),
		       auto_update, last_checked_at, last_installed_at,
		       COALESCE(install_path,''), created_at, updated_at
		FROM packages WHERE id = ?`, id).Scan(
		&p.ID, &p.Type, &p.Slug, &p.Name, &p.RepoURL,
		&p.Description, &p.InstalledVersion, &p.PinnedVersion,
		&p.AutoUpdate, &p.LastCheckedAt, &p.LastInstalledAt,
		&p.InstallPath, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("getting package %s: %w", id, err)
	}
	return &p, nil
}

// FindBySlug looks up a package by its slug.
func (r *packageRepository) FindBySlug(ctx context.Context, slug string) (*Package, error) {
	var p Package
	err := r.db.QueryRowContext(ctx, `
		SELECT id, type, slug, name, repo_url, COALESCE(description,''),
		       COALESCE(installed_version,''), COALESCE(pinned_version,''),
		       auto_update, last_checked_at, last_installed_at,
		       COALESCE(install_path,''), created_at, updated_at
		FROM packages WHERE slug = ?`, slug).Scan(
		&p.ID, &p.Type, &p.Slug, &p.Name, &p.RepoURL,
		&p.Description, &p.InstalledVersion, &p.PinnedVersion,
		&p.AutoUpdate, &p.LastCheckedAt, &p.LastInstalledAt,
		&p.InstallPath, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("finding package by slug %s: %w", slug, err)
	}
	return &p, nil
}

// FindByRepoURL looks up a package by its repository URL.
func (r *packageRepository) FindByRepoURL(ctx context.Context, repoURL string) (*Package, error) {
	var p Package
	err := r.db.QueryRowContext(ctx, `
		SELECT id, type, slug, name, repo_url, COALESCE(description,''),
		       COALESCE(installed_version,''), COALESCE(pinned_version,''),
		       auto_update, last_checked_at, last_installed_at,
		       COALESCE(install_path,''), created_at, updated_at
		FROM packages WHERE repo_url = ?`, repoURL).Scan(
		&p.ID, &p.Type, &p.Slug, &p.Name, &p.RepoURL,
		&p.Description, &p.InstalledVersion, &p.PinnedVersion,
		&p.AutoUpdate, &p.LastCheckedAt, &p.LastInstalledAt,
		&p.InstallPath, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("finding package by repo URL: %w", err)
	}
	return &p, nil
}

// CreatePackage inserts a new package record.
func (r *packageRepository) CreatePackage(ctx context.Context, pkg *Package) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO packages (id, type, slug, name, repo_url, description,
		                      installed_version, pinned_version, auto_update,
		                      last_checked_at, last_installed_at, install_path)
		VALUES (?, ?, ?, ?, ?, ?, NULLIF(?,''), NULLIF(?,''), ?, ?, ?, NULLIF(?,''))`,
		pkg.ID, pkg.Type, pkg.Slug, pkg.Name, pkg.RepoURL, pkg.Description,
		pkg.InstalledVersion, pkg.PinnedVersion, pkg.AutoUpdate,
		pkg.LastCheckedAt, pkg.LastInstalledAt, pkg.InstallPath)
	if err != nil {
		return fmt.Errorf("creating package: %w", err)
	}
	return nil
}

// UpdatePackage updates an existing package record.
func (r *packageRepository) UpdatePackage(ctx context.Context, pkg *Package) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE packages SET name = ?, description = ?,
		       installed_version = NULLIF(?,''), pinned_version = NULLIF(?,''),
		       auto_update = ?, last_checked_at = ?, last_installed_at = ?,
		       install_path = NULLIF(?,'')
		WHERE id = ?`,
		pkg.Name, pkg.Description,
		pkg.InstalledVersion, pkg.PinnedVersion,
		pkg.AutoUpdate, pkg.LastCheckedAt, pkg.LastInstalledAt,
		pkg.InstallPath, pkg.ID)
	if err != nil {
		return fmt.Errorf("updating package %s: %w", pkg.ID, err)
	}
	return nil
}

// DeletePackage removes a package and cascades to its versions.
func (r *packageRepository) DeletePackage(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM packages WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("deleting package %s: %w", id, err)
	}
	return nil
}

// ListVersions returns all versions for a package, newest first.
func (r *packageRepository) ListVersions(ctx context.Context, packageID string) ([]PackageVersion, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, package_id, version, tag_name, release_url, download_url,
		       COALESCE(release_notes,''), published_at, downloaded_at,
		       COALESCE(file_size, 0), created_at
		FROM package_versions
		WHERE package_id = ?
		ORDER BY published_at DESC`, packageID)
	if err != nil {
		return nil, fmt.Errorf("listing versions for %s: %w", packageID, err)
	}
	defer rows.Close()

	var versions []PackageVersion
	for rows.Next() {
		var v PackageVersion
		if err := rows.Scan(&v.ID, &v.PackageID, &v.Version, &v.TagName,
			&v.ReleaseURL, &v.DownloadURL, &v.ReleaseNotes,
			&v.PublishedAt, &v.DownloadedAt, &v.FileSize, &v.CreatedAt); err != nil {
			return nil, fmt.Errorf("scanning version: %w", err)
		}
		versions = append(versions, v)
	}
	return versions, rows.Err()
}

// GetVersion returns a specific version by package ID and version string.
func (r *packageRepository) GetVersion(ctx context.Context, packageID, version string) (*PackageVersion, error) {
	var v PackageVersion
	err := r.db.QueryRowContext(ctx, `
		SELECT id, package_id, version, tag_name, release_url, download_url,
		       COALESCE(release_notes,''), published_at, downloaded_at,
		       COALESCE(file_size, 0), created_at
		FROM package_versions
		WHERE package_id = ? AND version = ?`, packageID, version).Scan(
		&v.ID, &v.PackageID, &v.Version, &v.TagName,
		&v.ReleaseURL, &v.DownloadURL, &v.ReleaseNotes,
		&v.PublishedAt, &v.DownloadedAt, &v.FileSize, &v.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("getting version %s/%s: %w", packageID, version, err)
	}
	return &v, nil
}

// UpsertVersion inserts a version or updates it if the package_id+version pair exists.
func (r *packageRepository) UpsertVersion(ctx context.Context, v *PackageVersion) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO package_versions (id, package_id, version, tag_name, release_url,
		                              download_url, release_notes, published_at, file_size)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		    tag_name = VALUES(tag_name),
		    release_url = VALUES(release_url),
		    download_url = VALUES(download_url),
		    release_notes = VALUES(release_notes),
		    file_size = VALUES(file_size)`,
		v.ID, v.PackageID, v.Version, v.TagName, v.ReleaseURL,
		v.DownloadURL, v.ReleaseNotes, v.PublishedAt, v.FileSize)
	if err != nil {
		return fmt.Errorf("upserting version: %w", err)
	}
	return nil
}

// MarkVersionDownloaded sets the downloaded_at timestamp for a version.
func (r *packageRepository) MarkVersionDownloaded(ctx context.Context, id string) error {
	now := time.Now()
	_, err := r.db.ExecContext(ctx,
		`UPDATE package_versions SET downloaded_at = ? WHERE id = ?`, now, id)
	if err != nil {
		return fmt.Errorf("marking version downloaded: %w", err)
	}
	return nil
}
