package modules

import (
	"github.com/labstack/echo/v4"

	"github.com/keyxmakerx/chronicle/internal/apperror"
	"github.com/keyxmakerx/chronicle/internal/middleware"
	"github.com/keyxmakerx/chronicle/internal/plugins/addons"
	"github.com/keyxmakerx/chronicle/internal/plugins/auth"
	"github.com/keyxmakerx/chronicle/internal/plugins/campaigns"
)

// RegisterRoutes sets up module reference page and API routes.
// Module routes are scoped to a campaign and gated by per-module
// addon checks (each module ID is an addon slug). Custom module
// upload/delete routes are also registered here for campaign owners.
func RegisterRoutes(e *echo.Echo, h *ModuleHandler, addonSvc addons.AddonService, authSvc auth.AuthService, campaignSvc campaigns.CampaignService) {
	// Module routes: /campaigns/:id/modules/:mod/...
	// The :mod param is the module ID (e.g., "dnd5e").
	mg := e.Group("/campaigns/:id/modules/:mod",
		auth.RequireAuth(authSvc),
		campaigns.RequireCampaignAccess(campaignSvc),
		requireModuleAddon(addonSvc, h.campaignModules),
	)

	mg.GET("", h.Index)
	mg.GET("/search", h.SearchAPI)
	mg.GET("/:cat", h.CategoryList)
	mg.GET("/:cat/:item", h.ItemDetail)
	mg.GET("/:cat/:item/tooltip", h.TooltipAPI)
}

// RegisterCustomModuleRoutes sets up campaign owner routes for uploading
// and managing custom game system modules.
func RegisterCustomModuleRoutes(e *echo.Echo, ch *CampaignModuleHandler, authSvc auth.AuthService, campaignSvc campaigns.CampaignService) {
	cg := e.Group("/campaigns/:id/modules",
		auth.RequireAuth(authSvc),
		campaigns.RequireCampaignAccess(campaignSvc),
	)

	cg.POST("/upload", ch.UploadModule)
	cg.GET("/custom", ch.GetCustomModule)
	cg.DELETE("/custom", ch.DeleteModule)
}

// requireModuleAddon returns middleware that checks whether the module
// (identified by the :mod path param) is enabled as an addon for the
// campaign, OR is the campaign's custom uploaded module. This allows
// both built-in and custom modules to work through the same routes.
func requireModuleAddon(addonSvc addons.AddonService, cmm *CampaignModuleManager) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			modID := c.Param("mod")
			campaignID := c.Param("id")

			// Check if it's an enabled built-in module addon.
			enabled, err := addonSvc.IsEnabledForCampaign(c.Request().Context(), campaignID, modID)
			if err != nil {
				// Fail open on DB errors — let the request through.
				return next(c)
			}
			if enabled {
				return next(c)
			}

			// Check if it's the campaign's custom module.
			if cmm != nil {
				if manifest := cmm.GetManifest(campaignID); manifest != nil && manifest.ID == modID {
					return next(c)
				}
			}

			// Module not enabled and not a custom module.
			if middleware.IsHTMX(c) {
				return apperror.NewNotFound(modID + " module is not enabled for this campaign")
			}
			return c.Redirect(303, "/campaigns/"+campaignID)
		}
	}
}
