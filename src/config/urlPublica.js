function baseUrlPublica() {
  return (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '');
}

module.exports = { baseUrlPublica };
