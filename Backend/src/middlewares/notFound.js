function notFound(req, res, _next) {
  res.status(404).json({ message: "Not Found" });
}

module.exports = notFound;
