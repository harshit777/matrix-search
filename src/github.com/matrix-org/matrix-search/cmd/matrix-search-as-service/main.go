package main

import (
	"crypto/tls"
	"github.com/matrix-org/gomatrix"
	"github.com/matrix-org/matrix-search/appservice"
	"github.com/matrix-org/matrix-search/common"
	"net/http"
)

func main() {
	conf, reg := common.LoadConfigs()
	if conf == nil || reg == nil {
		panic("MISSING")
	}

	idxr, r := common.Setup(conf.Homeserver.URL, reg.SenderLocalpart, reg.ASToken)

	appservice.RegisterHandler(r, idxr, reg.HSToken)

	common.Begin(r, conf)
}
