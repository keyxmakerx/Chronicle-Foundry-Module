// Package packages manages external package repositories for Chronicle.
// It provides version management, auto-updates, and admin UI for game
// system packs and the Foundry VTT module pulled from GitHub repos.
package packages

import (
	"crypto/rand"
	"fmt"
	"io"
	"time"
)

// PackageType distinguishes system packs from Foundry modules.
type PackageType string

const (
	// PackageTypeSystem is a game system content pack (manifest.json + data/*.json).
	PackageTypeSystem PackageType = "system"

	// PackageTypeFoundryModule is the Foundry VTT sync module.
	PackageTypeFoundryModule PackageType = "foundry-module"
)

// UpdatePolicy controls automatic update behavior.
type UpdatePolicy string

const (
	// UpdateOff disables automatic updates.
	UpdateOff UpdatePolicy = "off"

	// UpdateNightly checks for updates once per day.
	UpdateNightly UpdatePolicy = "nightly"

	// UpdateWeekly checks for updates once per week.
	UpdateWeekly UpdatePolicy = "weekly"

	// UpdateOnRelease checks every hour for new releases.
	UpdateOnRelease UpdatePolicy = "on_release"
)

// Package represents an external repository tracked by the package manager.
type Package struct {
	ID               string
	Type             PackageType
	Slug             string
	Name             string
	RepoURL          string
	Description      string
	InstalledVersion string
	PinnedVersion    string
	AutoUpdate       UpdatePolicy
	LastCheckedAt    *time.Time
	LastInstalledAt  *time.Time
	InstallPath      string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// PackageVersion represents a single release from GitHub.
type PackageVersion struct {
	ID           string
	PackageID    string
	Version      string
	TagName      string
	ReleaseURL   string
	DownloadURL  string
	ReleaseNotes string
	PublishedAt  time.Time
	DownloadedAt *time.Time
	FileSize     int64
	CreatedAt    time.Time
}

// PackageUsage shows which campaigns use a package's systems.
type PackageUsage struct {
	CampaignID   string
	CampaignName string
	SystemID     string
	EnabledAt    time.Time
}

// AddPackageInput is the request to add a new package repository.
type AddPackageInput struct {
	RepoURL string `json:"repo_url" form:"repo_url"`
	Name    string `json:"name" form:"name"`
	Type    string `json:"type" form:"type"`
}

// UpdatePolicyInput is the request to change auto-update policy.
type UpdatePolicyInput struct {
	Policy string `json:"policy" form:"policy"`
}

// InstallVersionInput is the request to install a specific version.
type InstallVersionInput struct {
	Version string `json:"version" form:"version"`
}

// PinVersionInput is the request to pin to a specific version.
type PinVersionInput struct {
	Version string `json:"version" form:"version"`
}

// generateUUID creates a new v4 UUID string using crypto/rand.
// Panics if the system entropy source fails, as this indicates a
// catastrophic system problem that would compromise all security.
func generateUUID() string {
	uuid := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, uuid); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	uuid[6] = (uuid[6] & 0x0f) | 0x40
	uuid[8] = (uuid[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		uuid[0:4], uuid[4:6], uuid[6:8], uuid[8:10], uuid[10:16])
}
