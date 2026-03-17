package packages

import "github.com/labstack/echo/v4"

// RegisterRoutes mounts all package manager routes under the given admin group.
// All routes require site admin authentication (enforced by the parent group).
func RegisterRoutes(admin *echo.Group, h *Handler) {
	g := admin.Group("/packages")

	g.GET("", h.ListPackages)
	g.POST("", h.AddPackage)
	g.DELETE("/:id", h.RemovePackage)

	g.GET("/:id/versions", h.ListVersions)
	g.PUT("/:id/version", h.InstallVersion)
	g.PUT("/:id/pin", h.SetPinnedVersion)
	g.DELETE("/:id/pin", h.ClearPinnedVersion)
	g.PUT("/:id/auto-update", h.SetAutoUpdate)
	g.POST("/:id/check", h.CheckForUpdates)

	g.GET("/:id/usage", h.GetUsage)
}
