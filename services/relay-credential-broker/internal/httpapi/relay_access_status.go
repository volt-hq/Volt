package httpapi

import "net/http"

func (s *Server) handleRelayAccessStatus(writer http.ResponseWriter, request *http.Request) {
	if err := requireEmptyBody(request); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	token, ok := bearerToken(request)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "refresh_token_required")
		return
	}
	status, err := s.broker.RelayAccessStatus(request.Context(), token)
	if err != nil {
		s.writeAuthenticatedError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, status)
}
