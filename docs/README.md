# TeamShare Documentation

Welcome to the TeamShare documentation. This directory contains comprehensive documentation organized by category to help you understand and work with the TeamShare application.

## 📋 Project & IP

- **[Bedrock IP Documentation](./BEDROCK_IP_DOCUMENTATION.md)** - Outline of existing intellectual property, ideas, functionality, and codebase information (for contract handover and IP documentation)

## 📚 Documentation Structure

The documentation is organized into the following categories:

- **[Frontend](./frontend/)** - Frontend architecture, components, stores, and development guides
- **[Backend](./backend/)** - Backend APIs, server documentation, and performance guides
- **[Streaming](./streaming/)** - Real-time data streaming service, WebSocket API, and data processing
- **[Python](./python/)** - Python service API, script execution, and FastAPI documentation
- **[Database](./database/)** - Database schema and data structure documentation
- **[System](./system/)** - System configuration, network setup, and general architecture
- **[Testing](./testing/)** - Testing guides and best practices

---

## 🎨 Frontend Documentation

Frontend documentation covers the SolidJS application architecture, components, state management, and development practices.

### Core Architecture
- **[Frontend Architecture](./frontend/frontend-architecture.md)** - Overall frontend structure, routing, state management, and multi-window synchronization
- **[Frontend Stores](./frontend/frontend-stores.md)** - Detailed documentation of all SolidJS stores and their cross-window sync mechanisms
- **[Frontend Services](./frontend/frontend-services.md)** - API integration services and data fetching patterns
- **[Frontend Developer Guide](./frontend/frontend-developer-guide.md)** - Development setup, patterns, and best practices

### Components & Features
- **[Charts and Builders](./frontend/frontend-charts-and-builders.md)** - Chart components, builders, and visualization system
- **[Sidebar Menu Logic](./frontend/sidebar-menu-logic.md)** - Dynamic sidebar menu generation, modes, and reactive updates
- **[SimpleScatter Architecture](./frontend/simpleScatter-architecture.md)** - SimpleScatter component architecture and implementation

### Architecture & Performance
- **[Page Scaling Strategy](./frontend/page-scaling-strategy.md)** - Strategies for handling large datasets and performance optimization
- **[Performance Page Scroll Fix](./frontend/performance-page-scroll-fix.md)** - How scrolling and scaling were fixed for Performance and Fleet Performance (overflow, padding, JS-driven scroll container height)
- **[Maneuver TimeSeries Scroll Fix](./frontend/maneuver-timeseries-scroll-fix.md)** - Container height calculation for scaled pages (inverse-scale formula)

---

## ⚙️ Backend Documentation

Backend documentation covers server APIs, endpoints, performance optimizations, and server configuration.

### API Documentation
- **[Server App API](./backend/server-app-api.md)** - Main application API endpoints and functionality
- **[Server Admin API](./backend/server-admin-api.md)** - Administrative API endpoints and user management
- **[Server File Media API](./backend/server-file-media-api.md)** - File upload and media handling API
- **[OpenAPI Specification](./backend/openapi-app.yaml)** - Complete API specification in OpenAPI format

### Performance & Optimization
- **[API Compression](./backend/API_COMPRESSION.md)** - API response compression strategies and implementation
- **[Database Pool Configuration](./backend/DATABASE_POOL_CONFIGURATION.md)** - Database connection pooling configuration and best practices
- **[SSE Memory Leak Prevention](./backend/SSE_MEMORY_LEAK_PREVENTION.md)** - Server-Sent Events memory management and leak prevention

---

## 📡 Streaming Service Documentation

Streaming service documentation covers the real-time data ingestion and distribution system.

### Core Documentation
- **[Streaming Service Overview](./streaming/streaming-service-overview.md)** - Architecture, components, and data flow
- **[API Reference](./streaming/streaming-api-reference.md)** - Complete REST API and WebSocket API documentation
- **[Configuration](./streaming/streaming-configuration.md)** - Environment variables, Redis settings, and security configuration
- **[Data Processing](./streaming/streaming-data-processing.md)** - State machine processor, computed channels, and data transformation
- **[Deployment Guide](./streaming/streaming-deployment.md)** - Local development, Docker, nginx configuration, and scaling

### Key Features
- Multi-source support (up to 20 concurrent WebSocket or InfluxDB connections)
- Real-time processing with computed channels (TACK, POINTOFSAIL, MANEUVER_TYPE)
- Redis-based time-series storage with 24-hour retention
- WebSocket broadcasting to subscribed clients
- Automatic reconnection with exponential backoff
- JWT authentication for secure access

---

## 🐍 Python Service Documentation

Python service documentation covers the FastAPI-based Python service for script execution, real-time monitoring, and data processing.

### Service Overview
- **[Python Service Overview](./python/python-service-overview.md)** - FastAPI Python wrapper for external scripts, features, and file structure

### API Documentation
- **[API Documentation](./python/API_DOCUMENTATION.md)** - Complete Python service API documentation with endpoints, authentication, and examples
- **[OpenAPI Summary](./python/OPENAPI_SUMMARY.md)** - OpenAPI documentation summary, interactive testing, and endpoint overview

### Features
- Script execution with real-time progress monitoring via Server-Sent Events (SSE)
- Authentication via JWT tokens and Personal Access Tokens (PAT)
- Background script execution
- Data fetching and processing
- Interactive API documentation (Swagger UI and ReDoc)

---

## 🗄️ Database Documentation

Database documentation covers schema, relationships, and data structures.

- **[Database Schema](./database/database-schema.md)** - Complete database schema documentation, entities, and relationships

---

## 🔧 System Documentation

System documentation covers network configuration, authentication, permissions, and general system architecture.

### Configuration
- **[Network Configuration](./system/NETWORK_CONFIGURATION.md)** - Network setup, server configuration, and deployment architecture

### Authentication & Authorization
- **[Subscriptions and Permissions](./system/subscriptions-and-permissions.md)** - User subscription system, permission levels, and access control

### Maintenance
- **[User Projects Fix](./system/user-projects-fix.md)** - Documentation of user project management fixes and improvements

---

## 🧪 Testing Documentation

Testing documentation covers testing strategies, patterns, and best practices.

- **[Filter Reactivity Testing Guide](./testing/filter-reactivity-testing-guide.md)** - Testing patterns for filter state management and reactivity

---

## 🚀 Quick Start Guides

### For Frontend Developers
1. Start with [Frontend Architecture](./frontend/frontend-architecture.md) for an overview
2. Review [Frontend Stores](./frontend/frontend-stores.md) for state management patterns
3. Check [Frontend Developer Guide](./frontend/frontend-developer-guide.md) for development setup
4. Explore [Charts and Builders](./frontend/frontend-charts-and-builders.md) for visualization components

### For Backend Developers
1. Review [Server App API](./backend/server-app-api.md) for main endpoints
2. Check [Database Schema](./database/database-schema.md) for data structure
3. Use [OpenAPI Specification](./backend/openapi-app.yaml) for complete API reference
4. Review [Database Pool Configuration](./backend/DATABASE_POOL_CONFIGURATION.md) for connection management

### For Streaming Service Developers
1. Start with [Streaming Service Overview](./streaming/streaming-service-overview.md) for architecture
2. Review [API Reference](./streaming/streaming-api-reference.md) for endpoints and WebSocket protocol
3. Check [Data Processing](./streaming/streaming-data-processing.md) for computed channels and state machine
4. Follow [Deployment Guide](./streaming/streaming-deployment.md) for setup and configuration

### For Python Service Developers
1. Start with [Python Service Overview](./python/python-service-overview.md) for service architecture
2. Review [API Documentation](./python/API_DOCUMENTATION.md) for endpoint details
3. Check [OpenAPI Summary](./python/OPENAPI_SUMMARY.md) for interactive documentation
4. Access Swagger UI at `http://localhost:8049/docs` when the service is running

### For System Administrators
1. Review [Network Configuration](./system/NETWORK_CONFIGURATION.md) for deployment setup
2. Check [Subscriptions and Permissions](./system/subscriptions-and-permissions.md) for user management
3. Review [Server Admin API](./backend/server-admin-api.md) for administrative functions
4. Use [Database Schema](./database/database-schema.md) for system configuration

### For QA/Testing
1. Start with [Filter Reactivity Testing Guide](./testing/filter-reactivity-testing-guide.md)
2. Review component-specific testing patterns in frontend documentation

---

## 📝 Documentation Standards

### File Naming
- Use kebab-case for file names (e.g., `frontend-architecture.md`)
- Use descriptive names that clearly indicate content
- Group related documentation in appropriate subdirectories

### Content Structure
- Start with an overview section
- Include detailed technical specifications
- Provide code examples where relevant
- Include troubleshooting and debugging information
- Document any breaking changes or migration paths

### Maintenance
- Update documentation when making significant changes
- Remove outdated or irrelevant documentation
- Keep examples current with the codebase
- Include version information for API changes
- Update this README when adding new documentation files

---

## 🤝 Contributing to Documentation

When adding or updating documentation:

1. **Follow naming conventions** - Use kebab-case for file names
2. **Include comprehensive examples** - Code examples should be tested and working
3. **Update this index** - Add new files to the appropriate section in this README
4. **Remove outdated content** - Clean up obsolete documentation when making changes
5. **Test code examples** - Ensure all code examples work before committing
6. **Use proper folder structure** - Place files in the appropriate category folder

---

## 📅 Last Updated

This documentation index was last updated: November 2025

---

## 🔍 Finding Documentation

If you're looking for specific information:

- **API endpoints?** → Check [Backend](./backend/) folder
- **Real-time streaming?** → Check [Streaming](./streaming/) folder
- **Python service?** → Check [Python](./python/) folder
- **Component architecture?** → Check [Frontend](./frontend/) folder
- **Database structure?** → Check [Database](./database/) folder
- **Deployment/config?** → Check [System](./system/) folder
- **Testing patterns?** → Check [Testing](./testing/) folder
