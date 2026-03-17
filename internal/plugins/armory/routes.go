// routes.go registers Armory gallery endpoints on the Echo router.
// The gallery page is readable by Players; all routes are gated behind
// the "armory" addon.
package armory

import (
	"github.com/labstack/echo/v4"

	"github.com/keyxmakerx/chronicle/internal/plugins/addons"
	"github.com/keyxmakerx/chronicle/internal/plugins/auth"
	"github.com/keyxmakerx/chronicle/internal/plugins/campaigns"
)

// RegisterRoutes sets up Armory gallery routes on the Echo instance.
// Public-capable routes use AllowPublicCampaignAccess so public campaigns
// show items to unauthenticated visitors. All routes are gated behind the
// "armory" addon — campaign owners can enable/disable via the Plugin Hub.
func RegisterRoutes(e *echo.Echo, h *Handler, th *TransactionHandler, campaignSvc campaigns.CampaignService, authSvc auth.AuthService, addonSvc addons.AddonService) {
	// Public-capable routes: gallery view (Player+).
	pub := e.Group("/campaigns/:id",
		auth.OptionalAuth(authSvc),
		campaigns.AllowPublicCampaignAccess(campaignSvc),
		addons.RequireAddon(addonSvc, "armory"),
	)
	pub.GET("/armory", h.Index, campaigns.RequireRole(campaigns.RolePlayer))
	pub.GET("/armory/count", h.CountAPI, campaigns.RequireRole(campaigns.RolePlayer))

	// Transaction routes require authenticated campaign member.
	txGroup := e.Group("/campaigns/:id",
		auth.RequireAuth(authSvc),
		campaigns.RequireCampaignAccess(campaignSvc),
		addons.RequireAddon(addonSvc, "armory"),
	)
	txGroup.POST("/armory/purchase", th.Purchase, campaigns.RequireRole(campaigns.RoleScribe))
	txGroup.POST("/armory/transactions", th.CreateTransaction, campaigns.RequireRole(campaigns.RoleScribe))
	txGroup.GET("/armory/transactions", th.ListTransactions, campaigns.RequireRole(campaigns.RolePlayer))
	txGroup.GET("/armory/shops/:eid/transactions", th.ListShopTransactions, campaigns.RequireRole(campaigns.RolePlayer))
}
