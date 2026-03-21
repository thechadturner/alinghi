--
-- PostgreSQL database dump
--

\restrict nhDC4QYGHefFB8N1jaHQnZRHsflPFN5GqBnf66o4j6JBdcLkM7UfirYBBnBqH1o

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

-- Started on 2026-01-26 13:39:08

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- TOC entry 6 (class 2615 OID 1067234)
-- Name: admin; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA admin;


ALTER SCHEMA admin OWNER TO postgres;

--
-- TOC entry 7 (class 2615 OID 1067235)
-- Name: gp50; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA gp50;


ALTER SCHEMA gp50 OWNER TO postgres;

--
-- TOC entry 286 (class 1255 OID 1067236)
-- Name: cleanup_expired_verifications(); Type: FUNCTION; Schema: admin; Owner: postgres
--

CREATE FUNCTION admin.cleanup_expired_verifications() RETURNS TABLE(deleted_unverified integer, expired_verifications integer, expired_password_resets integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    unverified_count integer := 0;
    verification_count integer := 0;
    password_reset_count integer := 0;
BEGIN
    -- Delete expired unverified users
    DELETE FROM admin.users_unverified 
    WHERE expires_at < NOW();
    
    GET DIAGNOSTICS unverified_count = ROW_COUNT;
    
    -- Clear expired verification codes from users table
    UPDATE admin.users 
    SET secret_code = NULL, 
        verification_expires_at = NULL,
        verification_attempts = 0
    WHERE verification_expires_at < NOW();
    
    GET DIAGNOSTICS verification_count = ROW_COUNT;
    
    -- Clear expired password reset codes from users table
    UPDATE admin.users 
    SET password_reset_code = NULL, 
        password_reset_expires_at = NULL,
        password_reset_attempts = 0
    WHERE password_reset_expires_at < NOW();
    
    GET DIAGNOSTICS password_reset_count = ROW_COUNT;
    
    -- Return cleanup statistics
    RETURN QUERY SELECT unverified_count, verification_count, password_reset_count;
END;
$$;


ALTER FUNCTION admin.cleanup_expired_verifications() OWNER TO postgres;

--
-- TOC entry 5350 (class 0 OID 0)
-- Dependencies: 286
-- Name: FUNCTION cleanup_expired_verifications(); Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON FUNCTION admin.cleanup_expired_verifications() IS 'Cleans up expired verification records and returns cleanup statistics';


--
-- TOC entry 287 (class 1255 OID 1067237)
-- Name: project_updated(); Type: FUNCTION; Schema: admin; Owner: postgres
--

CREATE FUNCTION admin.project_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.date_modified := CURRENT_DATE;
    RETURN NEW;
END;$$;


ALTER FUNCTION admin.project_updated() OWNER TO postgres;

--
-- TOC entry 288 (class 1255 OID 1067238)
-- Name: truncate_activity_tables(); Type: FUNCTION; Schema: admin; Owner: postgres
--

CREATE FUNCTION admin.truncate_activity_tables() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  TRUNCATE TABLE admin.log_activity, admin.user_activity
  RESTART IDENTITY CASCADE;
END;
$$;


ALTER FUNCTION admin.truncate_activity_tables() OWNER TO postgres;

--
-- TOC entry 289 (class 1255 OID 1067239)
-- Name: truncate_logs(); Type: FUNCTION; Schema: admin; Owner: postgres
--

CREATE FUNCTION admin.truncate_logs() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  TRUNCATE TABLE admin.log_activity
  RESTART IDENTITY CASCADE;
END;
$$;


ALTER FUNCTION admin.truncate_logs() OWNER TO postgres;

--
-- TOC entry 290 (class 1255 OID 1067240)
-- Name: validate_password_strength(text); Type: FUNCTION; Schema: admin; Owner: postgres
--

CREATE FUNCTION admin.validate_password_strength(password text) RETURNS boolean
    LANGUAGE plpgsql
    AS $_$
BEGIN
    -- Check minimum length
    IF length(password) < 8 THEN
        RETURN false;
    END IF;
    
    -- Check for at least one uppercase letter
    IF password !~ '[A-Z]' THEN
        RETURN false;
    END IF;
    
    -- Check for at least one lowercase letter
    IF password !~ '[a-z]' THEN
        RETURN false;
    END IF;
    
    -- Check for at least one number
    IF password !~ '[0-9]' THEN
        RETURN false;
    END IF;
    
    -- Check for at least one special character
    IF password !~ '[!@#$%^&*()_+\-=\[\]{};'':"\\|,.<>\/?]' THEN
        RETURN false;
    END IF;
    
    RETURN true;
END;
$_$;


ALTER FUNCTION admin.validate_password_strength(password text) OWNER TO postgres;

--
-- TOC entry 5351 (class 0 OID 0)
-- Dependencies: 290
-- Name: FUNCTION validate_password_strength(password text); Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON FUNCTION admin.validate_password_strength(password text) IS 'Validates password strength: 8+ chars, 1+ upper, 1+ lower, 1+ number, 1+ special char';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 219 (class 1259 OID 1067241)
-- Name: personal_api_tokens; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.personal_api_tokens (
    token_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    token_hash text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    ip_allowlist cidr[],
    project_ids integer[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_by uuid,
    metadata jsonb,
    CONSTRAINT chk_pat_expires_future CHECK ((expires_at > now())),
    CONSTRAINT chk_pat_name_len CHECK (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 100))),
    CONSTRAINT chk_pat_scopes_not_null CHECK ((scopes IS NOT NULL))
);


ALTER TABLE admin.personal_api_tokens OWNER TO postgres;

--
-- TOC entry 5352 (class 0 OID 0)
-- Dependencies: 219
-- Name: TABLE personal_api_tokens; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON TABLE admin.personal_api_tokens IS 'Long-lived service tokens (PATs) with scopes, IP allow-list, and project scoping';


--
-- TOC entry 5353 (class 0 OID 0)
-- Dependencies: 219
-- Name: COLUMN personal_api_tokens.token_hash; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.personal_api_tokens.token_hash IS 'One-way hash of the token (raw token never stored)';


--
-- TOC entry 5354 (class 0 OID 0)
-- Dependencies: 219
-- Name: COLUMN personal_api_tokens.scopes; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.personal_api_tokens.scopes IS 'Scopes: e.g., {read,write,upload,admin}';


--
-- TOC entry 5355 (class 0 OID 0)
-- Dependencies: 219
-- Name: COLUMN personal_api_tokens.ip_allowlist; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.personal_api_tokens.ip_allowlist IS 'Optional list of allowed CIDRs (e.g., {192.168.1.0/24,10.0.0.0/8})';


--
-- TOC entry 5356 (class 0 OID 0)
-- Dependencies: 219
-- Name: COLUMN personal_api_tokens.project_ids; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.personal_api_tokens.project_ids IS 'Optional project restriction for this token';


--
-- TOC entry 5357 (class 0 OID 0)
-- Dependencies: 219
-- Name: COLUMN personal_api_tokens.expires_at; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.personal_api_tokens.expires_at IS 'Token expiration (long-lived, e.g., 30–90 days)';


--
-- TOC entry 5358 (class 0 OID 0)
-- Dependencies: 219
-- Name: COLUMN personal_api_tokens.revoked_at; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.personal_api_tokens.revoked_at IS 'Set when token is revoked';


--
-- TOC entry 220 (class 1259 OID 1067252)
-- Name: active_personal_api_tokens; Type: VIEW; Schema: admin; Owner: postgres
--

CREATE VIEW admin.active_personal_api_tokens AS
 SELECT user_id,
    1 AS pat,
    token_hash
   FROM admin.personal_api_tokens
  WHERE (revoked_at IS NULL);


ALTER VIEW admin.active_personal_api_tokens OWNER TO postgres;

--
-- TOC entry 221 (class 1259 OID 1067256)
-- Name: user_subscriptions; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.user_subscriptions (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    subscription_type character varying(50) NOT NULL,
    status character varying(20) NOT NULL,
    start_date date DEFAULT now() NOT NULL,
    end_date date NOT NULL,
    auto_renew boolean DEFAULT true,
    canceled_at date,
    created_at date DEFAULT now(),
    CONSTRAINT subscriptions_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('canceled'::character varying)::text, ('expired'::character varying)::text, ('trial'::character varying)::text]))),
    CONSTRAINT subscriptions_subscription_type_check CHECK (((subscription_type)::text = ANY (ARRAY[('api'::character varying)::text, ('enterprise'::character varying)::text, ('standard'::character varying)::text, ('pro'::character varying)::text, ('standard_plus'::character varying)::text, ('pro_plus'::character varying)::text, ('standard_complete'::character varying)::text, ('free'::character varying)::text, ('member'::character varying)::text])))
);


ALTER TABLE admin.user_subscriptions OWNER TO postgres;

--
-- TOC entry 222 (class 1259 OID 1067264)
-- Name: active_user_subscriptions; Type: VIEW; Schema: admin; Owner: postgres
--

CREATE VIEW admin.active_user_subscriptions AS
 SELECT user_id,
    subscription_type
   FROM admin.user_subscriptions
  WHERE ((status)::text = 'active'::text);


ALTER VIEW admin.active_user_subscriptions OWNER TO postgres;

--
-- TOC entry 223 (class 1259 OID 1067268)
-- Name: billing_events; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.billing_events (
    id uuid NOT NULL,
    user_id uuid,
    subscription_id integer NOT NULL,
    event_type character varying,
    amount_cents integer,
    currency character varying(3),
    billing_provider character varying,
    external_reference character varying,
    status character varying,
    created_at timestamp without time zone
);


ALTER TABLE admin.billing_events OWNER TO postgres;

--
-- TOC entry 224 (class 1259 OID 1067273)
-- Name: billing_events_subscription_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.billing_events_subscription_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.billing_events_subscription_id_seq OWNER TO postgres;

--
-- TOC entry 5359 (class 0 OID 0)
-- Dependencies: 224
-- Name: billing_events_subscription_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.billing_events_subscription_id_seq OWNED BY admin.billing_events.subscription_id;


--
-- TOC entry 225 (class 1259 OID 1067274)
-- Name: classes; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.classes (
    class_id integer NOT NULL,
    class_name character varying(50) NOT NULL,
    icon character varying(50) NOT NULL,
    size_m double precision NOT NULL
);


ALTER TABLE admin.classes OWNER TO postgres;

--
-- TOC entry 226 (class 1259 OID 1067277)
-- Name: classes_class_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.classes_class_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.classes_class_id_seq OWNER TO postgres;

--
-- TOC entry 5360 (class 0 OID 0)
-- Dependencies: 226
-- Name: classes_class_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.classes_class_id_seq OWNED BY admin.classes.class_id;


--
-- TOC entry 227 (class 1259 OID 1067278)
-- Name: latest_billing_events; Type: VIEW; Schema: admin; Owner: postgres
--

CREATE VIEW admin.latest_billing_events AS
 SELECT subscription_id,
    billing_status,
    created_at,
    rn
   FROM ( SELECT billing_events.subscription_id,
            billing_events.status AS billing_status,
            billing_events.created_at,
            row_number() OVER (PARTITION BY billing_events.subscription_id ORDER BY billing_events.created_at DESC) AS rn
           FROM admin.billing_events) bill
  WHERE (rn = 1);


ALTER VIEW admin.latest_billing_events OWNER TO postgres;

--
-- TOC entry 228 (class 1259 OID 1067282)
-- Name: latest_user_subscriptions; Type: VIEW; Schema: admin; Owner: postgres
--

CREATE VIEW admin.latest_user_subscriptions AS
 SELECT subscription_id,
    user_id,
    subscription_type,
    status,
    created_at,
    rn
   FROM ( SELECT user_subscriptions.id AS subscription_id,
            user_subscriptions.user_id,
            user_subscriptions.subscription_type,
            user_subscriptions.status,
            user_subscriptions.created_at,
            row_number() OVER (PARTITION BY user_subscriptions.user_id ORDER BY user_subscriptions.created_at DESC) AS rn
           FROM admin.user_subscriptions) sub
  WHERE (rn = 1);


ALTER VIEW admin.latest_user_subscriptions OWNER TO postgres;

--
-- TOC entry 229 (class 1259 OID 1067286)
-- Name: log_activity; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.log_activity (
    id integer NOT NULL,
    datetime timestamp with time zone DEFAULT now() NOT NULL,
    client_ip inet,
    user_id uuid NOT NULL,
    file_name character varying(100),
    log_type character varying(50),
    log_level character varying(50),
    message text,
    context text
);


ALTER TABLE admin.log_activity OWNER TO postgres;

--
-- TOC entry 230 (class 1259 OID 1067292)
-- Name: log_activity_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.log_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.log_activity_id_seq OWNER TO postgres;

--
-- TOC entry 5361 (class 0 OID 0)
-- Dependencies: 230
-- Name: log_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.log_activity_id_seq OWNED BY admin.log_activity.id;


--
-- TOC entry 231 (class 1259 OID 1067293)
-- Name: meta_influx_channels; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.meta_influx_channels (
    source_name text NOT NULL,
    date text NOT NULL,
    level text DEFAULT 'strm'::text NOT NULL,
    channels jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE admin.meta_influx_channels OWNER TO postgres;

--
-- TOC entry 232 (class 1259 OID 1067300)
-- Name: projects; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.projects (
    project_id integer NOT NULL,
    project_name text NOT NULL,
    class_id integer,
    user_id uuid,
    date_created date DEFAULT CURRENT_TIMESTAMP,
    date_modified date DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE admin.projects OWNER TO postgres;

--
-- TOC entry 233 (class 1259 OID 1067307)
-- Name: projects_project_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.projects_project_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.projects_project_id_seq OWNER TO postgres;

--
-- TOC entry 5362 (class 0 OID 0)
-- Dependencies: 233
-- Name: projects_project_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.projects_project_id_seq OWNED BY admin.projects.project_id;


--
-- TOC entry 234 (class 1259 OID 1067308)
-- Name: token_blacklist; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.token_blacklist (
    token_id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_jti character varying(255) NOT NULL,
    user_id uuid NOT NULL,
    revoked_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone NOT NULL,
    reason character varying(100) DEFAULT 'user_logout'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE admin.token_blacklist OWNER TO postgres;

--
-- TOC entry 235 (class 1259 OID 1067315)
-- Name: user_activity; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.user_activity (
    id integer NOT NULL,
    datetime timestamp with time zone DEFAULT now() NOT NULL,
    client_ip inet,
    user_id uuid NOT NULL,
    project_id integer NOT NULL,
    dataset_id integer NOT NULL,
    file_name character varying(100),
    message character varying(50),
    context text
);


ALTER TABLE admin.user_activity OWNER TO postgres;

--
-- TOC entry 236 (class 1259 OID 1067321)
-- Name: user_activity_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.user_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.user_activity_id_seq OWNER TO postgres;

--
-- TOC entry 5363 (class 0 OID 0)
-- Dependencies: 236
-- Name: user_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.user_activity_id_seq OWNED BY admin.user_activity.id;


--
-- TOC entry 237 (class 1259 OID 1067322)
-- Name: user_migrations; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.user_migrations (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    migration_type character varying(50) NOT NULL,
    old_token_type character varying(50) NOT NULL,
    new_token_type character varying(50) NOT NULL,
    migrated_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE admin.user_migrations OWNER TO postgres;

--
-- TOC entry 238 (class 1259 OID 1067327)
-- Name: user_migrations_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.user_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.user_migrations_id_seq OWNER TO postgres;

--
-- TOC entry 5364 (class 0 OID 0)
-- Dependencies: 238
-- Name: user_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.user_migrations_id_seq OWNED BY admin.user_migrations.id;


--
-- TOC entry 239 (class 1259 OID 1067328)
-- Name: user_projects; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.user_projects (
    user_id uuid,
    project_id integer,
    permission character varying(20)
);


ALTER TABLE admin.user_projects OWNER TO postgres;

--
-- TOC entry 240 (class 1259 OID 1067331)
-- Name: user_rules; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.user_rules (
    project_id integer NOT NULL,
    type character varying(50) NOT NULL,
    "json" json
);


ALTER TABLE admin.user_rules OWNER TO postgres;

--
-- TOC entry 241 (class 1259 OID 1067336)
-- Name: user_settings; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.user_settings (
    object_id integer NOT NULL,
    user_id uuid NOT NULL,
    "json" jsonb,
    date_modified date
);


ALTER TABLE admin.user_settings OWNER TO postgres;

--
-- TOC entry 242 (class 1259 OID 1067341)
-- Name: user_settings_object_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.user_settings_object_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.user_settings_object_id_seq OWNER TO postgres;

--
-- TOC entry 5365 (class 0 OID 0)
-- Dependencies: 242
-- Name: user_settings_object_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.user_settings_object_id_seq OWNED BY admin.user_settings.object_id;


--
-- TOC entry 243 (class 1259 OID 1067342)
-- Name: user_subscriptions_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.user_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.user_subscriptions_id_seq OWNER TO postgres;

--
-- TOC entry 5366 (class 0 OID 0)
-- Dependencies: 243
-- Name: user_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.user_subscriptions_id_seq OWNED BY admin.user_subscriptions.id;


--
-- TOC entry 244 (class 1259 OID 1067343)
-- Name: users; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.users (
    user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_name character varying(20) NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email character varying(255) NOT NULL,
    profile_picture text,
    password_hash text NOT NULL,
    secret_code integer,
    is_active boolean DEFAULT true,
    is_verified boolean DEFAULT false,
    created_at date DEFAULT now(),
    updated_at date DEFAULT now(),
    last_login_at timestamp with time zone,
    deleted_at date,
    tags jsonb,
    verification_expires_at timestamp with time zone,
    password_reset_code character varying(10),
    password_reset_expires_at timestamp with time zone,
    verification_attempts integer DEFAULT 0,
    password_reset_attempts integer DEFAULT 0,
    CONSTRAINT chk_password_reset_code_format CHECK (((password_reset_code IS NULL) OR ((password_reset_code)::text ~ '^[0-9]{4}$'::text))),
    CONSTRAINT chk_valid_email CHECK (((email)::text ~~ '%@%'::text)),
    CONSTRAINT chk_valid_user_name CHECK (((user_name)::text ~ '^[a-zA-Z0-9_]+$'::text)),
    CONSTRAINT chk_verification_code_format CHECK (((secret_code IS NULL) OR ((secret_code)::text ~ '^[0-9]{4}$'::text)))
);


ALTER TABLE admin.users OWNER TO postgres;

--
-- TOC entry 5367 (class 0 OID 0)
-- Dependencies: 244
-- Name: COLUMN users.verification_expires_at; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users.verification_expires_at IS 'Expiration time for verification codes';


--
-- TOC entry 5368 (class 0 OID 0)
-- Dependencies: 244
-- Name: COLUMN users.password_reset_code; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users.password_reset_code IS '4-digit code for password reset';


--
-- TOC entry 5369 (class 0 OID 0)
-- Dependencies: 244
-- Name: COLUMN users.password_reset_expires_at; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users.password_reset_expires_at IS 'Expiration time for password reset codes';


--
-- TOC entry 5370 (class 0 OID 0)
-- Dependencies: 244
-- Name: COLUMN users.verification_attempts; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users.verification_attempts IS 'Number of verification attempts made';


--
-- TOC entry 5371 (class 0 OID 0)
-- Dependencies: 244
-- Name: COLUMN users.password_reset_attempts; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users.password_reset_attempts IS 'Number of password reset attempts made';


--
-- TOC entry 245 (class 1259 OID 1067359)
-- Name: users_pending; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.users_pending (
    id integer NOT NULL,
    project_id integer NOT NULL,
    email character varying(255) NOT NULL,
    permission character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    date_created date DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE admin.users_pending OWNER TO postgres;

--
-- TOC entry 246 (class 1259 OID 1067364)
-- Name: users_pending_id_seq; Type: SEQUENCE; Schema: admin; Owner: postgres
--

CREATE SEQUENCE admin.users_pending_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE admin.users_pending_id_seq OWNER TO postgres;

--
-- TOC entry 5372 (class 0 OID 0)
-- Dependencies: 246
-- Name: users_pending_id_seq; Type: SEQUENCE OWNED BY; Schema: admin; Owner: postgres
--

ALTER SEQUENCE admin.users_pending_id_seq OWNED BY admin.users_pending.id;


--
-- TOC entry 247 (class 1259 OID 1067365)
-- Name: users_unverified; Type: TABLE; Schema: admin; Owner: postgres
--

CREATE TABLE admin.users_unverified (
    unverified_id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email character varying(255) NOT NULL,
    password_hash text NOT NULL,
    verification_code character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval),
    attempts integer DEFAULT 0,
    ip_address inet,
    user_agent text,
    permission character varying(50) DEFAULT 'administrator'::character varying,
    CONSTRAINT chk_valid_unverified_email CHECK (((email)::text ~~ '%@%'::text)),
    CONSTRAINT chk_verification_code_format CHECK (((verification_code)::text ~ '^[0-9]{4}$'::text))
);


ALTER TABLE admin.users_unverified OWNER TO postgres;

--
-- TOC entry 5373 (class 0 OID 0)
-- Dependencies: 247
-- Name: TABLE users_unverified; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON TABLE admin.users_unverified IS 'Stores unverified users during registration process';


--
-- TOC entry 5374 (class 0 OID 0)
-- Dependencies: 247
-- Name: COLUMN users_unverified.verification_code; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users_unverified.verification_code IS '4-digit verification code sent via email';


--
-- TOC entry 5375 (class 0 OID 0)
-- Dependencies: 247
-- Name: COLUMN users_unverified.expires_at; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users_unverified.expires_at IS 'Verification code expiration time (24 hours from creation)';


--
-- TOC entry 5376 (class 0 OID 0)
-- Dependencies: 247
-- Name: COLUMN users_unverified.attempts; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users_unverified.attempts IS 'Number of verification attempts made';


--
-- TOC entry 5377 (class 0 OID 0)
-- Dependencies: 247
-- Name: COLUMN users_unverified.permission; Type: COMMENT; Schema: admin; Owner: postgres
--

COMMENT ON COLUMN admin.users_unverified.permission IS 'Default permission level for new users (administrator)';


--
-- TOC entry 248 (class 1259 OID 1067377)
-- Name: class_objects; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.class_objects (
    object_id integer NOT NULL,
    object_name text,
    "json" jsonb,
    date_modified date
);


ALTER TABLE gp50.class_objects OWNER TO postgres;

--
-- TOC entry 249 (class 1259 OID 1067382)
-- Name: class_objects_object_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.class_objects_object_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.class_objects_object_id_seq OWNER TO postgres;

--
-- TOC entry 5378 (class 0 OID 0)
-- Dependencies: 249
-- Name: class_objects_object_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.class_objects_object_id_seq OWNED BY gp50.class_objects.object_id;


--
-- TOC entry 250 (class 1259 OID 1067383)
-- Name: comments; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.comments (
    comment_id integer NOT NULL,
    dataset_id integer NOT NULL,
    user_id uuid,
    datetime timestamp with time zone,
    comment text
);


ALTER TABLE gp50.comments OWNER TO postgres;

--
-- TOC entry 251 (class 1259 OID 1067388)
-- Name: comments_comment_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.comments_comment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.comments_comment_id_seq OWNER TO postgres;

--
-- TOC entry 5379 (class 0 OID 0)
-- Dependencies: 251
-- Name: comments_comment_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.comments_comment_id_seq OWNED BY gp50.comments.comment_id;


--
-- TOC entry 252 (class 1259 OID 1067389)
-- Name: dataset_events; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.dataset_events (
    event_id integer NOT NULL,
    dataset_id integer NOT NULL,
    event_type text,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    tags jsonb,
    duration double precision
);


ALTER TABLE gp50.dataset_events OWNER TO postgres;

--
-- TOC entry 253 (class 1259 OID 1067394)
-- Name: dataset_events_event_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.dataset_events_event_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.dataset_events_event_id_seq OWNER TO postgres;

--
-- TOC entry 5380 (class 0 OID 0)
-- Dependencies: 253
-- Name: dataset_events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.dataset_events_event_id_seq OWNED BY gp50.dataset_events.event_id;


--
-- TOC entry 254 (class 1259 OID 1067395)
-- Name: dataset_objects; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.dataset_objects (
    object_id integer NOT NULL,
    dataset_id integer,
    parent_name text,
    object_name text,
    "json" jsonb,
    date_modified date
);


ALTER TABLE gp50.dataset_objects OWNER TO postgres;

--
-- TOC entry 255 (class 1259 OID 1067400)
-- Name: dataset_objects_object_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.dataset_objects_object_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.dataset_objects_object_id_seq OWNER TO postgres;

--
-- TOC entry 5381 (class 0 OID 0)
-- Dependencies: 255
-- Name: dataset_objects_object_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.dataset_objects_object_id_seq OWNED BY gp50.dataset_objects.object_id;


--
-- TOC entry 256 (class 1259 OID 1067401)
-- Name: dataset_pages; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.dataset_pages (
    dataset_id integer NOT NULL,
    page_id integer NOT NULL,
    date_modified date DEFAULT CURRENT_DATE
);


ALTER TABLE gp50.dataset_pages OWNER TO postgres;

--
-- TOC entry 257 (class 1259 OID 1067405)
-- Name: dataset_sharing; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.dataset_sharing (
    id integer NOT NULL,
    dataset_id integer,
    project_id integer,
    active integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


ALTER TABLE gp50.dataset_sharing OWNER TO postgres;

--
-- TOC entry 258 (class 1259 OID 1067411)
-- Name: dataset_sharing_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.dataset_sharing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.dataset_sharing_id_seq OWNER TO postgres;

--
-- TOC entry 5382 (class 0 OID 0)
-- Dependencies: 258
-- Name: dataset_sharing_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.dataset_sharing_id_seq OWNED BY gp50.dataset_sharing.id;


--
-- TOC entry 259 (class 1259 OID 1067412)
-- Name: dataset_targets; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.dataset_targets (
    dataset_id integer NOT NULL,
    target_id integer NOT NULL,
    tack text NOT NULL
);


ALTER TABLE gp50.dataset_targets OWNER TO postgres;

--
-- TOC entry 260 (class 1259 OID 1067417)
-- Name: datasets; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.datasets (
    dataset_id integer NOT NULL,
    source_id integer NOT NULL,
    date date,
    year_name text,
    event_name text,
    report_name text,
    description text,
    tags jsonb,
    date_modified timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    visible integer DEFAULT 0,
    shared integer DEFAULT 0,
    timezone text DEFAULT 'Europe/Madrid'::text
);


ALTER TABLE gp50.datasets OWNER TO postgres;

--
-- TOC entry 261 (class 1259 OID 1067426)
-- Name: datasets_dataset_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.datasets_dataset_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.datasets_dataset_id_seq OWNER TO postgres;

--
-- TOC entry 5383 (class 0 OID 0)
-- Dependencies: 261
-- Name: datasets_dataset_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.datasets_dataset_id_seq OWNED BY gp50.datasets.dataset_id;


--
-- TOC entry 262 (class 1259 OID 1067427)
-- Name: events_aggregate; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.events_aggregate (
    agr_id integer NOT NULL,
    event_id integer NOT NULL,
    agr_type text,
    "Datetime" timestamp with time zone,
    "Tws_kph" double precision,
    "Tws_bow_kph" double precision,
    "Tws_mhu_kph" double precision,
    "Twd_deg" double precision,
    "Twd_bow_deg" double precision,
    "Twd_mhu_deg" double precision,
    "Tws_exp" double precision,
    "Tws_delta_kph" double precision,
    "Twa_delta_deg" double precision,
    "Awa_deg" double precision,
    "Awa_n_deg" double precision,
    "Aws_kph" double precision,
    "Twa_deg" double precision,
    "Twa_n_deg" double precision,
    "Cwa_deg" double precision,
    "Cwa_n_deg" double precision,
    "Hdg_deg" double precision,
    "Cog_deg" double precision,
    "Sog_kph" double precision,
    "Bsp_kph" double precision,
    "Bsp_tgt_kph" double precision,
    "Bsp_perc" double precision,
    "Vmg_kph" double precision,
    "Vmg_tgt_kph" double precision,
    "Vmg_perc" double precision,
    "Pitch_deg" double precision,
    "Heel_n_deg" double precision,
    "Lwy_n_deg" double precision,
    "Pitch_rate_dps" double precision,
    "Yaw_rate_n_dps" double precision,
    "Roll_rate_n_dps" double precision,
    "Accel_rate_mps2" double precision,
    "RH_lwd_mm" double precision,
    "RH_wwd_mm" double precision,
    "RH_bow_mm" double precision,
    "RUD_ang_n_deg" double precision,
    "RUD_rake_ang_deg" double precision,
    "RUD_diff_ang_deg" double precision,
    "DB_rake_ang_lwd_deg" double precision,
    "DB_rake_aoa_lwd_deg" double precision,
    "DB_cant_lwd_deg" double precision,
    "DB_cant_lwd_eff_deg" double precision,
    "DB_imm_lwd_mm" double precision,
    "DB_piercing_lwd_mm" double precision,
    "RUD_imm_lwd_mm" double precision,
    "RUD_imm_wwd_mm" double precision,
    "RUD_imm_tot_mm" double precision,
    "CA1_ang_n_deg" double precision,
    "CA2_ang_n_deg" double precision,
    "CA3_ang_n_deg" double precision,
    "CA4_ang_n_deg" double precision,
    "CA5_ang_n_deg" double precision,
    "CA6_ang_n_deg" double precision,
    "WING_twist_n_deg" double precision,
    "WING_rot_n_deg" double precision,
    "WING_aoa_n_deg" double precision,
    "WING_clew_pos_mm" double precision,
    "JIB_sheet_load_kgf" double precision,
    "JIB_cunno_load_kgf" double precision,
    "JIB_lead_ang_deg" double precision,
    "BOBSTAY_load_tf" double precision,
    "SHRD_lwr_lwd_tf" double precision,
    "SHRD_lwr_wwd_tf" double precision,
    "SHRD_upr_lwd_tf" double precision,
    "SHRD_upr_wwd_tf" double precision,
    "RIG_load_tf" double precision,
    "Foiling_state" double precision,
    "JIB_sheet_pct" double precision
);


ALTER TABLE gp50.events_aggregate OWNER TO postgres;

--
-- TOC entry 263 (class 1259 OID 1067432)
-- Name: events_aggregate_agr_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.events_aggregate_agr_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.events_aggregate_agr_id_seq OWNER TO postgres;

--
-- TOC entry 5384 (class 0 OID 0)
-- Dependencies: 263
-- Name: events_aggregate_agr_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.events_aggregate_agr_id_seq OWNED BY gp50.events_aggregate.agr_id;


--
-- TOC entry 264 (class 1259 OID 1067433)
-- Name: events_cloud; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.events_cloud (
    obs_id integer NOT NULL,
    event_id integer NOT NULL,
    "Datetime" timestamp with time zone,
    "Tws_kph" double precision,
    "Tws_bow_kph" double precision,
    "Tws_mhu_kph" double precision,
    "Twd_deg" double precision,
    "Twd_bow_deg" double precision,
    "Twd_mhu_deg" double precision,
    "Tws_exp" double precision,
    "Tws_delta_kph" double precision,
    "Twa_delta_deg" double precision,
    "Awa_deg" double precision,
    "Awa_n_deg" double precision,
    "Aws_kph" double precision,
    "Twa_deg" double precision,
    "Twa_n_deg" double precision,
    "Cwa_deg" double precision,
    "Cwa_n_deg" double precision,
    "Hdg_deg" double precision,
    "Cog_deg" double precision,
    "Sog_kph" double precision,
    "Bsp_kph" double precision,
    "Bsp_tgt_kph" double precision,
    "Bsp_perc" double precision,
    "Vmg_kph" double precision,
    "Vmg_tgt_kph" double precision,
    "Vmg_perc" double precision,
    "Pitch_deg" double precision,
    "Heel_n_deg" double precision,
    "Lwy_n_deg" double precision,
    "Pitch_rate_dps" double precision,
    "Yaw_rate_n_dps" double precision,
    "Roll_rate_n_dps" double precision,
    "Accel_rate_mps2" double precision,
    "RH_lwd_mm" double precision,
    "RH_wwd_mm" double precision,
    "RH_bow_mm" double precision,
    "RUD_ang_n_deg" double precision,
    "RUD_rake_ang_deg" double precision,
    "RUD_diff_ang_deg" double precision,
    "DB_rake_ang_lwd_deg" double precision,
    "DB_rake_aoa_lwd_deg" double precision,
    "DB_cant_lwd_deg" double precision,
    "DB_cant_lwd_eff_deg" double precision,
    "DB_imm_lwd_mm" double precision,
    "DB_piercing_lwd_mm" double precision,
    "RUD_imm_lwd_mm" double precision,
    "RUD_imm_wwd_mm" double precision,
    "RUD_imm_tot_mm" double precision,
    "CA1_ang_n_deg" double precision,
    "CA2_ang_n_deg" double precision,
    "CA3_ang_n_deg" double precision,
    "CA4_ang_n_deg" double precision,
    "CA5_ang_n_deg" double precision,
    "CA6_ang_n_deg" double precision,
    "WING_twist_n_deg" double precision,
    "WING_rot_n_deg" double precision,
    "WING_aoa_n_deg" double precision,
    "WING_clew_pos_mm" double precision,
    "JIB_sheet_load_kgf" double precision,
    "JIB_cunno_load_kgf" double precision,
    "JIB_lead_ang_deg" double precision,
    "BOBSTAY_load_tf" double precision,
    "SHRD_lwr_lwd_tf" double precision,
    "SHRD_lwr_wwd_tf" double precision,
    "SHRD_upr_lwd_tf" double precision,
    "SHRD_upr_wwd_tf" double precision,
    "RIG_load_tf" double precision,
    "Foiling_state" double precision,
    "JIB_sheet_pct" double precision
);


ALTER TABLE gp50.events_cloud OWNER TO postgres;

--
-- TOC entry 265 (class 1259 OID 1067436)
-- Name: events_cloud_obs_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.events_cloud_obs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.events_cloud_obs_id_seq OWNER TO postgres;

--
-- TOC entry 5385 (class 0 OID 0)
-- Dependencies: 265
-- Name: events_cloud_obs_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.events_cloud_obs_id_seq OWNED BY gp50.events_cloud.obs_id;


--
-- TOC entry 266 (class 1259 OID 1067437)
-- Name: events_mapdata; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.events_mapdata (
    mapdata_id integer NOT NULL,
    event_id integer NOT NULL,
    description text,
    "json" jsonb
);


ALTER TABLE gp50.events_mapdata OWNER TO postgres;

--
-- TOC entry 267 (class 1259 OID 1067442)
-- Name: events_mapdata_mapdata_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.events_mapdata_mapdata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.events_mapdata_mapdata_id_seq OWNER TO postgres;

--
-- TOC entry 5386 (class 0 OID 0)
-- Dependencies: 267
-- Name: events_mapdata_mapdata_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.events_mapdata_mapdata_id_seq OWNED BY gp50.events_mapdata.mapdata_id;


--
-- TOC entry 268 (class 1259 OID 1067443)
-- Name: events_timeseries; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.events_timeseries (
    timeseries_id integer NOT NULL,
    event_id integer NOT NULL,
    description text,
    "json" jsonb
);


ALTER TABLE gp50.events_timeseries OWNER TO postgres;

--
-- TOC entry 269 (class 1259 OID 1067448)
-- Name: events_timeseries_timeseries_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.events_timeseries_timeseries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.events_timeseries_timeseries_id_seq OWNER TO postgres;

--
-- TOC entry 5387 (class 0 OID 0)
-- Dependencies: 269
-- Name: events_timeseries_timeseries_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.events_timeseries_timeseries_id_seq OWNED BY gp50.events_timeseries.timeseries_id;


--
-- TOC entry 270 (class 1259 OID 1067449)
-- Name: sources; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.sources (
    source_id integer NOT NULL,
    project_id integer NOT NULL,
    source_name text NOT NULL,
    color text DEFAULT '#ff0000'::text NOT NULL,
    visible integer DEFAULT 0 NOT NULL,
    fleet integer DEFAULT 0 NOT NULL
);


ALTER TABLE gp50.sources OWNER TO postgres;

--
-- TOC entry 271 (class 1259 OID 1067457)
-- Name: fleet_datasets; Type: VIEW; Schema: gp50; Owner: postgres
--

CREATE VIEW gp50.fleet_datasets AS
 SELECT a.date,
    mode() WITHIN GROUP (ORDER BY a.report_name) AS report_name,
    a.year_name,
    a.event_name,
    string_agg(b.source_name, ', '::text) AS sources
   FROM (gp50.datasets a
     JOIN gp50.sources b ON ((a.source_id = b.source_id)))
  WHERE (b.fleet = 1)
  GROUP BY a.date, a.event_name, a.year_name
 HAVING (count(DISTINCT b.source_name) > 1);


ALTER VIEW gp50.fleet_datasets OWNER TO postgres;

--
-- TOC entry 272 (class 1259 OID 1067462)
-- Name: maneuver_stats; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.maneuver_stats (
    event_id integer NOT NULL,
    "Datetime" timestamp with time zone NOT NULL,
    "Tws_avg" double precision,
    "Tws_bin" integer,
    "Twd_avg" double precision,
    "Twd_cor" double precision,
    "Vmg_avg" double precision,
    "Tws_delta" double precision,
    "Twd_delta" double precision,
    "Start_time" double precision,
    "Entry_time" double precision,
    "Accel_min_time" double precision,
    "Bsp_min_time" double precision,
    "Bsp_max_time" double precision,
    "Accel_max_time" double precision,
    "Exit_time" double precision,
    "Final_time" double precision,
    "Time_decel" double precision,
    "Time_accel" double precision,
    "Time_total" double precision,
    "Bsp_start" double precision,
    "Bsp_entry" double precision,
    "Bsp_exit" double precision,
    "Bsp_accmax" double precision,
    "Bsp_build" double precision,
    "Bsp_final" double precision,
    "Bsp_min" double precision,
    "Bsp_min_delta" double precision,
    "Bsp_max" double precision,
    "Twa_start" double precision,
    "Twa_entry" double precision,
    "Twa_exit" double precision,
    "Twa_accmax" double precision,
    "Twa_build" double precision,
    "Twa_final" double precision,
    "Accel_min" double precision,
    "Accel_max" double precision,
    "Turn_radius" double precision,
    "Turn_rate_avg" double precision,
    "Turn_rate_max" double precision,
    "Time_turning" double precision,
    "Turn_angle" double precision,
    "Turn_angle_max" double precision,
    "Overshoot_angle" double precision,
    "Lwy_max" double precision,
    "Decel_slope" double precision,
    "Accel_slope" double precision,
    "Bsp_delta_start" double precision,
    "Twa_delta_start" double precision,
    "Vmg_perc_start" double precision,
    "Bsp_delta_build" double precision,
    "Twa_delta_build" double precision,
    "Vmg_perc_build" double precision,
    "Vmg_perc_avg" double precision,
    "Mmg" double precision,
    "Loss_inv_vmg" double precision,
    "Loss_turn_vmg" double precision,
    "Loss_build_vmg" double precision,
    "Loss_total_vmg" double precision,
    "Loss_inv_tgt" double precision,
    "Loss_turn_tgt" double precision,
    "Loss_build_tgt" double precision,
    "Loss_total_tgt" double precision,
    tag jsonb,
    "Cant_accmax" double precision,
    "Cant_eff_accmax" double precision,
    "Pitch_accmax" double precision,
    "Heel_accmax" double precision,
    "Jib_sheet_pct_accmax" double precision,
    "Jib_lead_ang_accmax" double precision,
    "Jib_cunno_load_accmax" double precision,
    "Wing_clew_pos_accmax" double precision,
    "Wing_twist_accmax" double precision,
    "Drop_time" double precision,
    "Bsp_drop" double precision,
    "Cant_drop" double precision,
    "Rake_drop" double precision,
    "Aoa_drop" double precision,
    "Raise_time" double precision,
    "Bsp_raise" double precision,
    "Pop_time" double precision,
    "Time_two_boards" double precision,
    "Vmg_total_avg" double precision,
    "Vmg_inv_avg" double precision,
    "Vmg_turn_avg" double precision,
    "Vmg_build_avg" double precision,
    "Vmg_baseline" double precision,
    "Vmg_applied" double precision
);


ALTER TABLE gp50.maneuver_stats OWNER TO postgres;

--
-- TOC entry 273 (class 1259 OID 1067467)
-- Name: media; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.media (
    media_id integer NOT NULL,
    project_id integer NOT NULL,
    date date,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    duration double precision,
    file_name text NOT NULL,
    media_source text,
    tags jsonb,
    shared integer DEFAULT 0
);


ALTER TABLE gp50.media OWNER TO postgres;

--
-- TOC entry 274 (class 1259 OID 1067473)
-- Name: media_media_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.media_media_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.media_media_id_seq OWNER TO postgres;

--
-- TOC entry 5388 (class 0 OID 0)
-- Dependencies: 274
-- Name: media_media_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.media_media_id_seq OWNED BY gp50.media.media_id;


--
-- TOC entry 275 (class 1259 OID 1067474)
-- Name: pages; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.pages (
    page_id integer NOT NULL,
    sort_id integer NOT NULL,
    page_type text,
    page_name text,
    description text,
    path_name text,
    icon text,
    version integer,
    version_notes text,
    date_created date DEFAULT CURRENT_DATE NOT NULL,
    permission_level integer DEFAULT 0
);


ALTER TABLE gp50.pages OWNER TO postgres;

--
-- TOC entry 276 (class 1259 OID 1067481)
-- Name: pages_page_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.pages_page_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.pages_page_id_seq OWNER TO postgres;

--
-- TOC entry 5389 (class 0 OID 0)
-- Dependencies: 276
-- Name: pages_page_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.pages_page_id_seq OWNED BY gp50.pages.page_id;


--
-- TOC entry 277 (class 1259 OID 1067482)
-- Name: project_objects; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.project_objects (
    object_id integer NOT NULL,
    project_id integer,
    date date,
    object_name text,
    "json" jsonb,
    date_modified date
);


ALTER TABLE gp50.project_objects OWNER TO postgres;

--
-- TOC entry 278 (class 1259 OID 1067487)
-- Name: project_objects_object_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.project_objects_object_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.project_objects_object_id_seq OWNER TO postgres;

--
-- TOC entry 5390 (class 0 OID 0)
-- Dependencies: 278
-- Name: project_objects_object_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.project_objects_object_id_seq OWNED BY gp50.project_objects.object_id;


--
-- TOC entry 279 (class 1259 OID 1067488)
-- Name: project_pages; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.project_pages (
    project_id integer NOT NULL,
    page_id integer NOT NULL,
    date_modified date DEFAULT CURRENT_DATE
);


ALTER TABLE gp50.project_pages OWNER TO postgres;

--
-- TOC entry 280 (class 1259 OID 1067492)
-- Name: sources_source_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.sources_source_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.sources_source_id_seq OWNER TO postgres;

--
-- TOC entry 5391 (class 0 OID 0)
-- Dependencies: 280
-- Name: sources_source_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.sources_source_id_seq OWNED BY gp50.sources.source_id;


--
-- TOC entry 281 (class 1259 OID 1067493)
-- Name: targets; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.targets (
    target_id integer NOT NULL,
    project_id integer NOT NULL,
    name text,
    "json" jsonb,
    date_modified date DEFAULT CURRENT_TIMESTAMP,
    "isPolar" integer
);


ALTER TABLE gp50.targets OWNER TO postgres;

--
-- TOC entry 282 (class 1259 OID 1067499)
-- Name: targets_target_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.targets_target_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.targets_target_id_seq OWNER TO postgres;

--
-- TOC entry 5392 (class 0 OID 0)
-- Dependencies: 282
-- Name: targets_target_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.targets_target_id_seq OWNED BY gp50.targets.target_id;


--
-- TOC entry 283 (class 1259 OID 1067500)
-- Name: user_objects; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.user_objects (
    object_id integer NOT NULL,
    user_id uuid NOT NULL,
    parent_name text,
    object_name text,
    "json" jsonb,
    date_modified date
);


ALTER TABLE gp50.user_objects OWNER TO postgres;

--
-- TOC entry 284 (class 1259 OID 1067505)
-- Name: user_objects_object_id_seq; Type: SEQUENCE; Schema: gp50; Owner: postgres
--

CREATE SEQUENCE gp50.user_objects_object_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE gp50.user_objects_object_id_seq OWNER TO postgres;

--
-- TOC entry 5393 (class 0 OID 0)
-- Dependencies: 284
-- Name: user_objects_object_id_seq; Type: SEQUENCE OWNED BY; Schema: gp50; Owner: postgres
--

ALTER SEQUENCE gp50.user_objects_object_id_seq OWNED BY gp50.user_objects.object_id;


--
-- TOC entry 285 (class 1259 OID 1067506)
-- Name: user_pages; Type: TABLE; Schema: gp50; Owner: postgres
--

CREATE TABLE gp50.user_pages (
    user_id uuid NOT NULL,
    page_id integer NOT NULL,
    date_modified date DEFAULT CURRENT_DATE
);


ALTER TABLE gp50.user_pages OWNER TO postgres;

--
-- TOC entry 4944 (class 2604 OID 1067510)
-- Name: billing_events subscription_id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.billing_events ALTER COLUMN subscription_id SET DEFAULT nextval('admin.billing_events_subscription_id_seq'::regclass);


--
-- TOC entry 4945 (class 2604 OID 1067511)
-- Name: classes class_id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.classes ALTER COLUMN class_id SET DEFAULT nextval('admin.classes_class_id_seq'::regclass);


--
-- TOC entry 4946 (class 2604 OID 1067512)
-- Name: log_activity id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.log_activity ALTER COLUMN id SET DEFAULT nextval('admin.log_activity_id_seq'::regclass);


--
-- TOC entry 4950 (class 2604 OID 1067513)
-- Name: projects project_id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.projects ALTER COLUMN project_id SET DEFAULT nextval('admin.projects_project_id_seq'::regclass);


--
-- TOC entry 4957 (class 2604 OID 1067514)
-- Name: user_activity id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_activity ALTER COLUMN id SET DEFAULT nextval('admin.user_activity_id_seq'::regclass);


--
-- TOC entry 4959 (class 2604 OID 1067515)
-- Name: user_migrations id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_migrations ALTER COLUMN id SET DEFAULT nextval('admin.user_migrations_id_seq'::regclass);


--
-- TOC entry 4962 (class 2604 OID 1067516)
-- Name: user_settings object_id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_settings ALTER COLUMN object_id SET DEFAULT nextval('admin.user_settings_object_id_seq'::regclass);


--
-- TOC entry 4940 (class 2604 OID 1067517)
-- Name: user_subscriptions id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_subscriptions ALTER COLUMN id SET DEFAULT nextval('admin.user_subscriptions_id_seq'::regclass);


--
-- TOC entry 4970 (class 2604 OID 1067518)
-- Name: users_pending id; Type: DEFAULT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users_pending ALTER COLUMN id SET DEFAULT nextval('admin.users_pending_id_seq'::regclass);


--
-- TOC entry 4978 (class 2604 OID 1067519)
-- Name: class_objects object_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.class_objects ALTER COLUMN object_id SET DEFAULT nextval('gp50.class_objects_object_id_seq'::regclass);


--
-- TOC entry 4979 (class 2604 OID 1067520)
-- Name: comments comment_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.comments ALTER COLUMN comment_id SET DEFAULT nextval('gp50.comments_comment_id_seq'::regclass);


--
-- TOC entry 4980 (class 2604 OID 1067521)
-- Name: dataset_events event_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_events ALTER COLUMN event_id SET DEFAULT nextval('gp50.dataset_events_event_id_seq'::regclass);


--
-- TOC entry 4981 (class 2604 OID 1067522)
-- Name: dataset_objects object_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_objects ALTER COLUMN object_id SET DEFAULT nextval('gp50.dataset_objects_object_id_seq'::regclass);


--
-- TOC entry 4983 (class 2604 OID 1067523)
-- Name: dataset_sharing id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_sharing ALTER COLUMN id SET DEFAULT nextval('gp50.dataset_sharing_id_seq'::regclass);


--
-- TOC entry 4987 (class 2604 OID 1067524)
-- Name: datasets dataset_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.datasets ALTER COLUMN dataset_id SET DEFAULT nextval('gp50.datasets_dataset_id_seq'::regclass);


--
-- TOC entry 4992 (class 2604 OID 1067525)
-- Name: events_aggregate agr_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_aggregate ALTER COLUMN agr_id SET DEFAULT nextval('gp50.events_aggregate_agr_id_seq'::regclass);


--
-- TOC entry 4993 (class 2604 OID 1067526)
-- Name: events_cloud obs_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_cloud ALTER COLUMN obs_id SET DEFAULT nextval('gp50.events_cloud_obs_id_seq'::regclass);


--
-- TOC entry 4994 (class 2604 OID 1067527)
-- Name: events_mapdata mapdata_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_mapdata ALTER COLUMN mapdata_id SET DEFAULT nextval('gp50.events_mapdata_mapdata_id_seq'::regclass);


--
-- TOC entry 4995 (class 2604 OID 1067528)
-- Name: events_timeseries timeseries_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_timeseries ALTER COLUMN timeseries_id SET DEFAULT nextval('gp50.events_timeseries_timeseries_id_seq'::regclass);


--
-- TOC entry 5000 (class 2604 OID 1067529)
-- Name: media media_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.media ALTER COLUMN media_id SET DEFAULT nextval('gp50.media_media_id_seq'::regclass);


--
-- TOC entry 5002 (class 2604 OID 1067530)
-- Name: pages page_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.pages ALTER COLUMN page_id SET DEFAULT nextval('gp50.pages_page_id_seq'::regclass);


--
-- TOC entry 5005 (class 2604 OID 1067531)
-- Name: project_objects object_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.project_objects ALTER COLUMN object_id SET DEFAULT nextval('gp50.project_objects_object_id_seq'::regclass);


--
-- TOC entry 4996 (class 2604 OID 1067532)
-- Name: sources source_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.sources ALTER COLUMN source_id SET DEFAULT nextval('gp50.sources_source_id_seq'::regclass);


--
-- TOC entry 5007 (class 2604 OID 1067533)
-- Name: targets target_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.targets ALTER COLUMN target_id SET DEFAULT nextval('gp50.targets_target_id_seq'::regclass);


--
-- TOC entry 5009 (class 2604 OID 1067534)
-- Name: user_objects object_id; Type: DEFAULT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.user_objects ALTER COLUMN object_id SET DEFAULT nextval('gp50.user_objects_object_id_seq'::regclass);


--
-- TOC entry 5057 (class 2606 OID 1325609)
-- Name: user_activity activity_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);


--
-- TOC entry 5036 (class 2606 OID 1325611)
-- Name: billing_events billing_events_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.billing_events
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);


--
-- TOC entry 5038 (class 2606 OID 1325613)
-- Name: classes classes_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (class_id);


--
-- TOC entry 5042 (class 2606 OID 1325615)
-- Name: log_activity messages_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.log_activity
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- TOC entry 5045 (class 2606 OID 1325617)
-- Name: meta_influx_channels meta_influx_channels_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.meta_influx_channels
    ADD CONSTRAINT meta_influx_channels_pkey PRIMARY KEY (source_name, date, level);


--
-- TOC entry 5027 (class 2606 OID 1325619)
-- Name: personal_api_tokens personal_api_tokens_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.personal_api_tokens
    ADD CONSTRAINT personal_api_tokens_pkey PRIMARY KEY (token_id);


--
-- TOC entry 5029 (class 2606 OID 1325621)
-- Name: personal_api_tokens personal_api_tokens_token_hash_key; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.personal_api_tokens
    ADD CONSTRAINT personal_api_tokens_token_hash_key UNIQUE (token_hash);


--
-- TOC entry 5048 (class 2606 OID 1325623)
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (project_id);


--
-- TOC entry 5034 (class 2606 OID 1325625)
-- Name: user_subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- TOC entry 5053 (class 2606 OID 1325627)
-- Name: token_blacklist token_blacklist_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.token_blacklist
    ADD CONSTRAINT token_blacklist_pkey PRIMARY KEY (token_id);


--
-- TOC entry 5055 (class 2606 OID 1325629)
-- Name: token_blacklist token_blacklist_token_jti_key; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.token_blacklist
    ADD CONSTRAINT token_blacklist_token_jti_key UNIQUE (token_jti);


--
-- TOC entry 5060 (class 2606 OID 1325631)
-- Name: user_migrations user_migrations_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_migrations
    ADD CONSTRAINT user_migrations_pkey PRIMARY KEY (id);


--
-- TOC entry 5066 (class 2606 OID 1325633)
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (object_id);


--
-- TOC entry 5079 (class 2606 OID 1325635)
-- Name: users users_email_key; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- TOC entry 5086 (class 2606 OID 1325637)
-- Name: users_pending users_pending_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users_pending
    ADD CONSTRAINT users_pending_pkey PRIMARY KEY (id);


--
-- TOC entry 5081 (class 2606 OID 1325639)
-- Name: users users_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- TOC entry 5091 (class 2606 OID 1325641)
-- Name: users_unverified users_unverified_email_key; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users_unverified
    ADD CONSTRAINT users_unverified_email_key UNIQUE (email);


--
-- TOC entry 5093 (class 2606 OID 1325643)
-- Name: users_unverified users_unverified_pkey; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users_unverified
    ADD CONSTRAINT users_unverified_pkey PRIMARY KEY (unverified_id);


--
-- TOC entry 5083 (class 2606 OID 1325645)
-- Name: users users_user_name_key; Type: CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users
    ADD CONSTRAINT users_user_name_key UNIQUE (user_name);


--
-- TOC entry 5095 (class 2606 OID 1325647)
-- Name: class_objects class_objects_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.class_objects
    ADD CONSTRAINT class_objects_pkey PRIMARY KEY (object_id);


--
-- TOC entry 5097 (class 2606 OID 1325649)
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (comment_id);


--
-- TOC entry 5099 (class 2606 OID 1325651)
-- Name: dataset_events dataset_events_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_events
    ADD CONSTRAINT dataset_events_pkey PRIMARY KEY (event_id);


--
-- TOC entry 5107 (class 2606 OID 1325653)
-- Name: dataset_objects dataset_objects_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_objects
    ADD CONSTRAINT dataset_objects_pkey PRIMARY KEY (object_id);


--
-- TOC entry 5110 (class 2606 OID 1325655)
-- Name: dataset_pages dataset_pages_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_pages
    ADD CONSTRAINT dataset_pages_pkey PRIMARY KEY (dataset_id, page_id);


--
-- TOC entry 5113 (class 2606 OID 1325657)
-- Name: dataset_sharing dataset_sharing_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_sharing
    ADD CONSTRAINT dataset_sharing_pkey PRIMARY KEY (id);


--
-- TOC entry 5115 (class 2606 OID 1325659)
-- Name: dataset_targets dataset_targets_pk; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_targets
    ADD CONSTRAINT dataset_targets_pk PRIMARY KEY (dataset_id, target_id, tack);


--
-- TOC entry 5117 (class 2606 OID 1325661)
-- Name: datasets datasets_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.datasets
    ADD CONSTRAINT datasets_pkey PRIMARY KEY (dataset_id);


--
-- TOC entry 5123 (class 2606 OID 1325663)
-- Name: events_aggregate events_aggregate_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_aggregate
    ADD CONSTRAINT events_aggregate_pkey PRIMARY KEY (agr_id);


--
-- TOC entry 5127 (class 2606 OID 1325665)
-- Name: events_cloud events_cloud_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_cloud
    ADD CONSTRAINT events_cloud_pkey PRIMARY KEY (obs_id);


--
-- TOC entry 5130 (class 2606 OID 1325667)
-- Name: events_mapdata events_mapdata_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_mapdata
    ADD CONSTRAINT events_mapdata_pkey PRIMARY KEY (mapdata_id);


--
-- TOC entry 5134 (class 2606 OID 1325669)
-- Name: events_timeseries events_timeseries_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_timeseries
    ADD CONSTRAINT events_timeseries_pkey PRIMARY KEY (timeseries_id);


--
-- TOC entry 5144 (class 2606 OID 1325671)
-- Name: maneuver_stats maneuver_stats_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.maneuver_stats
    ADD CONSTRAINT maneuver_stats_pkey PRIMARY KEY (event_id);


--
-- TOC entry 5147 (class 2606 OID 1325673)
-- Name: media media_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (media_id);


--
-- TOC entry 5149 (class 2606 OID 1325675)
-- Name: pages pages_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (page_id);


--
-- TOC entry 5152 (class 2606 OID 1325677)
-- Name: project_objects project_objects_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.project_objects
    ADD CONSTRAINT project_objects_pkey PRIMARY KEY (object_id);


--
-- TOC entry 5155 (class 2606 OID 1325679)
-- Name: project_pages project_pages_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.project_pages
    ADD CONSTRAINT project_pages_pkey PRIMARY KEY (project_id, page_id);


--
-- TOC entry 5140 (class 2606 OID 1325681)
-- Name: sources sources_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (source_id);


--
-- TOC entry 5158 (class 2606 OID 1325683)
-- Name: targets targets_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.targets
    ADD CONSTRAINT targets_pkey PRIMARY KEY (target_id);


--
-- TOC entry 5161 (class 2606 OID 1325685)
-- Name: user_objects user_objects_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.user_objects
    ADD CONSTRAINT user_objects_pkey PRIMARY KEY (object_id);


--
-- TOC entry 5164 (class 2606 OID 1325687)
-- Name: user_pages user_pages_pkey; Type: CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.user_pages
    ADD CONSTRAINT user_pages_pkey PRIMARY KEY (user_id, page_id);


--
-- TOC entry 5084 (class 1259 OID 1325688)
-- Name: fki_fk_projects; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX fki_fk_projects ON admin.users_pending USING btree (project_id);


--
-- TOC entry 5061 (class 1259 OID 1325689)
-- Name: fki_user_projects_fk; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX fki_user_projects_fk ON admin.user_projects USING btree (project_id);


--
-- TOC entry 5062 (class 1259 OID 1325690)
-- Name: fki_user_projects_user_id_fk; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX fki_user_projects_user_id_fk ON admin.user_projects USING btree (user_id);


--
-- TOC entry 5064 (class 1259 OID 1325691)
-- Name: fki_user_settings_fk; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX fki_user_settings_fk ON admin.user_settings USING btree (user_id) WITH (fillfactor='100', deduplicate_items='true');


--
-- TOC entry 5039 (class 1259 OID 1325692)
-- Name: idx_classes_class_id; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_classes_class_id ON admin.classes USING btree (class_id);


--
-- TOC entry 5040 (class 1259 OID 1325693)
-- Name: idx_log_activity_user_id_id_desc; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_log_activity_user_id_id_desc ON admin.log_activity USING btree (user_id, id DESC);


--
-- TOC entry 5043 (class 1259 OID 1325694)
-- Name: idx_meta_influx_channels_lookup; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_meta_influx_channels_lookup ON admin.meta_influx_channels USING btree (source_name, date, level, updated_at);


--
-- TOC entry 5022 (class 1259 OID 1325695)
-- Name: idx_pat_active; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_pat_active ON admin.personal_api_tokens USING btree (user_id, expires_at) WHERE ((revoked_at IS NULL) AND (expires_at IS NOT NULL));


--
-- TOC entry 5023 (class 1259 OID 1325696)
-- Name: idx_pat_expires; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_pat_expires ON admin.personal_api_tokens USING btree (expires_at);


--
-- TOC entry 5024 (class 1259 OID 1325697)
-- Name: idx_pat_last_used; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_pat_last_used ON admin.personal_api_tokens USING btree (last_used_at);


--
-- TOC entry 5025 (class 1259 OID 1325698)
-- Name: idx_pat_user_id; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_pat_user_id ON admin.personal_api_tokens USING btree (user_id);


--
-- TOC entry 5046 (class 1259 OID 1325699)
-- Name: idx_projects_user_id; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_projects_user_id ON admin.projects USING btree (user_id);


--
-- TOC entry 5030 (class 1259 OID 1325700)
-- Name: idx_subscription_expiration; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_subscription_expiration ON admin.user_subscriptions USING btree (end_date);


--
-- TOC entry 5031 (class 1259 OID 1325701)
-- Name: idx_subscription_status; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_subscription_status ON admin.user_subscriptions USING btree (status);


--
-- TOC entry 5032 (class 1259 OID 1325702)
-- Name: idx_subscription_user; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_subscription_user ON admin.user_subscriptions USING btree (user_id);


--
-- TOC entry 5049 (class 1259 OID 1325703)
-- Name: idx_token_blacklist_expires; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_token_blacklist_expires ON admin.token_blacklist USING btree (expires_at);


--
-- TOC entry 5050 (class 1259 OID 1325704)
-- Name: idx_token_blacklist_jti; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_token_blacklist_jti ON admin.token_blacklist USING btree (token_jti);


--
-- TOC entry 5051 (class 1259 OID 1325705)
-- Name: idx_token_blacklist_user_id; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_token_blacklist_user_id ON admin.token_blacklist USING btree (user_id);


--
-- TOC entry 5058 (class 1259 OID 1325706)
-- Name: idx_user_activity_user_id_id_desc; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_user_activity_user_id_id_desc ON admin.user_activity USING btree (user_id, id DESC);


--
-- TOC entry 5063 (class 1259 OID 1325707)
-- Name: idx_user_projects_user_id; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_user_projects_user_id ON admin.user_projects USING btree (user_id, project_id);


--
-- TOC entry 5067 (class 1259 OID 1325708)
-- Name: idx_users_active; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_active ON admin.users USING btree (is_active);


--
-- TOC entry 5068 (class 1259 OID 1325709)
-- Name: idx_users_deleted_at; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_deleted_at ON admin.users USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- TOC entry 5069 (class 1259 OID 1325710)
-- Name: idx_users_email; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_email ON admin.users USING btree (email);


--
-- TOC entry 5070 (class 1259 OID 1325711)
-- Name: idx_users_last_login; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_last_login ON admin.users USING btree (last_login_at);


--
-- TOC entry 5071 (class 1259 OID 1325712)
-- Name: idx_users_password_reset_code; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_password_reset_code ON admin.users USING btree (password_reset_code) WHERE (password_reset_code IS NOT NULL);


--
-- TOC entry 5072 (class 1259 OID 1325713)
-- Name: idx_users_password_reset_expires; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_password_reset_expires ON admin.users USING btree (password_reset_expires_at) WHERE (password_reset_expires_at IS NOT NULL);


--
-- TOC entry 5073 (class 1259 OID 1325714)
-- Name: idx_users_secret_code; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_secret_code ON admin.users USING btree (secret_code) WHERE (secret_code IS NOT NULL);


--
-- TOC entry 5087 (class 1259 OID 1325715)
-- Name: idx_users_unverified_email; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_unverified_email ON admin.users_unverified USING btree (email);


--
-- TOC entry 5088 (class 1259 OID 1325716)
-- Name: idx_users_unverified_expires; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_unverified_expires ON admin.users_unverified USING btree (expires_at);


--
-- TOC entry 5089 (class 1259 OID 1325717)
-- Name: idx_users_unverified_verification; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_unverified_verification ON admin.users_unverified USING btree (email, verification_code);


--
-- TOC entry 5074 (class 1259 OID 1325718)
-- Name: idx_users_user_id; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_user_id ON admin.users USING btree (user_id);


--
-- TOC entry 5075 (class 1259 OID 1325719)
-- Name: idx_users_user_name; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_user_name ON admin.users USING btree (user_name);


--
-- TOC entry 5076 (class 1259 OID 1325720)
-- Name: idx_users_verification_expires; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_verification_expires ON admin.users USING btree (verification_expires_at) WHERE (verification_expires_at IS NOT NULL);


--
-- TOC entry 5077 (class 1259 OID 1325721)
-- Name: idx_users_verified; Type: INDEX; Schema: admin; Owner: postgres
--

CREATE INDEX idx_users_verified ON admin.users USING btree (is_verified);


--
-- TOC entry 5100 (class 1259 OID 1325722)
-- Name: fki_dataset_events_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_dataset_events_fk ON gp50.dataset_events USING btree (dataset_id);


--
-- TOC entry 5108 (class 1259 OID 1325723)
-- Name: fki_dataset_objects_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_dataset_objects_fk ON gp50.dataset_objects USING btree (dataset_id) WITH (fillfactor='100', deduplicate_items='true');


--
-- TOC entry 5111 (class 1259 OID 1325724)
-- Name: fki_dataset_pages_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_dataset_pages_fk ON gp50.dataset_pages USING btree (dataset_id);


--
-- TOC entry 5150 (class 1259 OID 1325725)
-- Name: fki_project_objects_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_project_objects_fk ON gp50.project_objects USING btree (project_id);


--
-- TOC entry 5153 (class 1259 OID 1325726)
-- Name: fki_project_pages_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_project_pages_fk ON gp50.project_pages USING btree (project_id);


--
-- TOC entry 5136 (class 1259 OID 1325727)
-- Name: fki_sources_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_sources_fk ON gp50.sources USING btree (project_id);


--
-- TOC entry 5156 (class 1259 OID 1325728)
-- Name: fki_targets_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_targets_fk ON gp50.targets USING btree (project_id);


--
-- TOC entry 5159 (class 1259 OID 1325729)
-- Name: fki_user_objects_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_user_objects_fk ON gp50.user_objects USING btree (user_id) WITH (fillfactor='100', deduplicate_items='true');


--
-- TOC entry 5162 (class 1259 OID 1325730)
-- Name: fki_user_pages_fk; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX fki_user_pages_fk ON gp50.user_pages USING btree (user_id);


--
-- TOC entry 5101 (class 1259 OID 1325731)
-- Name: idx_dataset_events_dataset_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_dataset_events_dataset_id ON gp50.dataset_events USING btree (dataset_id, event_id DESC);


--
-- TOC entry 5102 (class 1259 OID 1325732)
-- Name: idx_dataset_events_dataset_type; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_dataset_events_dataset_type ON gp50.dataset_events USING btree (dataset_id, event_type, start_time);


--
-- TOC entry 5103 (class 1259 OID 1325733)
-- Name: idx_dataset_events_filters; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_dataset_events_filters ON gp50.dataset_events USING btree (event_type, dataset_id);


--
-- TOC entry 5104 (class 1259 OID 1325734)
-- Name: idx_dataset_events_search; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_dataset_events_search ON gp50.dataset_events USING btree (dataset_id, event_type, start_time, end_time, event_id DESC);


--
-- TOC entry 5105 (class 1259 OID 1325735)
-- Name: idx_dataset_events_type_time_range; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_dataset_events_type_time_range ON gp50.dataset_events USING btree (event_type, start_time, end_time, dataset_id);


--
-- TOC entry 5118 (class 1259 OID 1325736)
-- Name: idx_datasets_source_date; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_datasets_source_date ON gp50.datasets USING btree (source_id, date DESC);


--
-- TOC entry 5119 (class 1259 OID 1325737)
-- Name: idx_datasets_source_year_date; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_datasets_source_year_date ON gp50.datasets USING btree (source_id, year_name, date DESC);


--
-- TOC entry 5120 (class 1259 OID 1325738)
-- Name: idx_datasets_source_year_event; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_datasets_source_year_event ON gp50.datasets USING btree (source_id, year_name, event_name);


--
-- TOC entry 5121 (class 1259 OID 1325739)
-- Name: idx_datasets_source_year_event_date; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_datasets_source_year_event_date ON gp50.datasets USING btree (source_id, year_name, event_name, date DESC);


--
-- TOC entry 5124 (class 1259 OID 1325740)
-- Name: idx_events_aggregate_event_agr; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_events_aggregate_event_agr ON gp50.events_aggregate USING btree (event_id, agr_type);


--
-- TOC entry 5125 (class 1259 OID 1325741)
-- Name: idx_events_aggregate_event_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_events_aggregate_event_id ON gp50.events_aggregate USING btree (event_id);


--
-- TOC entry 5128 (class 1259 OID 1325742)
-- Name: idx_events_cloud_event_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_events_cloud_event_id ON gp50.events_cloud USING btree (event_id);


--
-- TOC entry 5141 (class 1259 OID 1325743)
-- Name: idx_maneuver_stats_event_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_maneuver_stats_event_id ON gp50.maneuver_stats USING btree (event_id);


--
-- TOC entry 5145 (class 1259 OID 1325744)
-- Name: idx_media_date_source; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_media_date_source ON gp50.media USING btree (start_time, media_source);


--
-- TOC entry 5137 (class 1259 OID 1325745)
-- Name: idx_sources_project_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_sources_project_id ON gp50.sources USING btree (project_id);


--
-- TOC entry 5138 (class 1259 OID 1325746)
-- Name: idx_sources_project_name; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX idx_sources_project_name ON gp50.sources USING btree (project_id, source_name DESC);


--
-- TOC entry 5135 (class 1259 OID 1325747)
-- Name: indx_event_ts_event_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX indx_event_ts_event_id ON gp50.events_timeseries USING btree (event_id);


--
-- TOC entry 5131 (class 1259 OID 1325748)
-- Name: indx_events_mapdata_event_id; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX indx_events_mapdata_event_id ON gp50.events_mapdata USING btree (event_id);


--
-- TOC entry 5142 (class 1259 OID 1325749)
-- Name: indx_maneuver_stats; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX indx_maneuver_stats ON gp50.maneuver_stats USING btree (event_id);


--
-- TOC entry 5132 (class 1259 OID 1325750)
-- Name: indx_mapdata_desc; Type: INDEX; Schema: gp50; Owner: postgres
--

CREATE INDEX indx_mapdata_desc ON gp50.events_mapdata USING btree (event_id, description);


--
-- TOC entry 5168 (class 2606 OID 1325751)
-- Name: billing_events billing_events_subscription_id_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.billing_events
    ADD CONSTRAINT billing_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES admin.user_subscriptions(id);


--
-- TOC entry 5169 (class 2606 OID 1325756)
-- Name: billing_events billing_events_user_id_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.billing_events
    ADD CONSTRAINT billing_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES admin.users(user_id);


--
-- TOC entry 5170 (class 2606 OID 1325761)
-- Name: projects fk_class; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.projects
    ADD CONSTRAINT fk_class FOREIGN KEY (class_id) REFERENCES admin.classes(class_id) ON DELETE CASCADE;


--
-- TOC entry 5177 (class 2606 OID 1325766)
-- Name: users_pending fk_projects; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.users_pending
    ADD CONSTRAINT fk_projects FOREIGN KEY (project_id) REFERENCES admin.projects(project_id) ON DELETE CASCADE;


--
-- TOC entry 5171 (class 2606 OID 1325771)
-- Name: projects fk_user; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.projects
    ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


--
-- TOC entry 5165 (class 2606 OID 1325776)
-- Name: personal_api_tokens personal_api_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.personal_api_tokens
    ADD CONSTRAINT personal_api_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES admin.users(user_id);


--
-- TOC entry 5166 (class 2606 OID 1325781)
-- Name: personal_api_tokens personal_api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.personal_api_tokens
    ADD CONSTRAINT personal_api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


--
-- TOC entry 5167 (class 2606 OID 1325786)
-- Name: user_subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


--
-- TOC entry 5172 (class 2606 OID 1325791)
-- Name: token_blacklist token_blacklist_user_id_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.token_blacklist
    ADD CONSTRAINT token_blacklist_user_id_fkey FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


--
-- TOC entry 5173 (class 2606 OID 1325796)
-- Name: user_migrations user_migrations_user_id_fkey; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_migrations
    ADD CONSTRAINT user_migrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES admin.users(user_id);


--
-- TOC entry 5174 (class 2606 OID 1325801)
-- Name: user_projects user_projects_fk; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_projects
    ADD CONSTRAINT user_projects_fk FOREIGN KEY (project_id) REFERENCES admin.projects(project_id) ON DELETE CASCADE NOT VALID;


--
-- TOC entry 5175 (class 2606 OID 1325806)
-- Name: user_projects user_projects_user_id_fk; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_projects
    ADD CONSTRAINT user_projects_user_id_fk FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE NOT VALID;


--
-- TOC entry 5176 (class 2606 OID 1325811)
-- Name: user_settings user_settings_fk; Type: FK CONSTRAINT; Schema: admin; Owner: postgres
--

ALTER TABLE ONLY admin.user_settings
    ADD CONSTRAINT user_settings_fk FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


--
-- TOC entry 5178 (class 2606 OID 1325816)
-- Name: dataset_events datase_events_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_events
    ADD CONSTRAINT datase_events_fk FOREIGN KEY (dataset_id) REFERENCES gp50.datasets(dataset_id) ON DELETE CASCADE;


--
-- TOC entry 5179 (class 2606 OID 1325821)
-- Name: dataset_objects dataset_objects_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_objects
    ADD CONSTRAINT dataset_objects_fk FOREIGN KEY (dataset_id) REFERENCES gp50.datasets(dataset_id) ON DELETE CASCADE;


--
-- TOC entry 5180 (class 2606 OID 1325826)
-- Name: dataset_pages dataset_pages_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_pages
    ADD CONSTRAINT dataset_pages_fk FOREIGN KEY (dataset_id) REFERENCES gp50.datasets(dataset_id) ON DELETE CASCADE;


--
-- TOC entry 5181 (class 2606 OID 1325831)
-- Name: dataset_sharing dataset_sharing_dataset_id_fkey; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_sharing
    ADD CONSTRAINT dataset_sharing_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES gp50.datasets(dataset_id) ON DELETE CASCADE;


--
-- TOC entry 5182 (class 2606 OID 1325836)
-- Name: dataset_targets dataset_targets_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.dataset_targets
    ADD CONSTRAINT dataset_targets_fk FOREIGN KEY (dataset_id) REFERENCES gp50.datasets(dataset_id) ON DELETE CASCADE;


--
-- TOC entry 5183 (class 2606 OID 1325841)
-- Name: datasets datasets_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.datasets
    ADD CONSTRAINT datasets_fk FOREIGN KEY (source_id) REFERENCES gp50.sources(source_id) ON DELETE CASCADE;


--
-- TOC entry 5184 (class 2606 OID 1325846)
-- Name: events_aggregate events_aggregate_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_aggregate
    ADD CONSTRAINT events_aggregate_fk FOREIGN KEY (event_id) REFERENCES gp50.dataset_events(event_id) ON DELETE CASCADE;


--
-- TOC entry 5185 (class 2606 OID 1325851)
-- Name: events_cloud events_cloud_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_cloud
    ADD CONSTRAINT events_cloud_fk FOREIGN KEY (event_id) REFERENCES gp50.dataset_events(event_id) ON DELETE CASCADE;


--
-- TOC entry 5186 (class 2606 OID 1325856)
-- Name: events_mapdata events_mapdata_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_mapdata
    ADD CONSTRAINT events_mapdata_fk FOREIGN KEY (event_id) REFERENCES gp50.dataset_events(event_id) ON DELETE CASCADE;


--
-- TOC entry 5187 (class 2606 OID 1325861)
-- Name: events_timeseries events_timeseries_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.events_timeseries
    ADD CONSTRAINT events_timeseries_fk FOREIGN KEY (event_id) REFERENCES gp50.dataset_events(event_id) ON DELETE CASCADE;


--
-- TOC entry 5189 (class 2606 OID 1325866)
-- Name: maneuver_stats maneuver_stats_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.maneuver_stats
    ADD CONSTRAINT maneuver_stats_fk FOREIGN KEY (event_id) REFERENCES gp50.dataset_events(event_id) ON DELETE CASCADE;


--
-- TOC entry 5190 (class 2606 OID 1325871)
-- Name: project_objects project_objects_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.project_objects
    ADD CONSTRAINT project_objects_fk FOREIGN KEY (project_id) REFERENCES admin.projects(project_id) ON DELETE CASCADE;


--
-- TOC entry 5191 (class 2606 OID 1325876)
-- Name: project_pages project_pages_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.project_pages
    ADD CONSTRAINT project_pages_fk FOREIGN KEY (project_id) REFERENCES admin.projects(project_id) ON DELETE CASCADE NOT VALID;


--
-- TOC entry 5188 (class 2606 OID 1325881)
-- Name: sources sources_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.sources
    ADD CONSTRAINT sources_fk FOREIGN KEY (project_id) REFERENCES admin.projects(project_id) ON DELETE CASCADE NOT VALID;


--
-- TOC entry 5192 (class 2606 OID 1325886)
-- Name: targets targets_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.targets
    ADD CONSTRAINT targets_fk FOREIGN KEY (project_id) REFERENCES admin.projects(project_id) ON DELETE CASCADE NOT VALID;


--
-- TOC entry 5193 (class 2606 OID 1325891)
-- Name: user_objects user_objects_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.user_objects
    ADD CONSTRAINT user_objects_fk FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


--
-- TOC entry 5194 (class 2606 OID 1325896)
-- Name: user_pages user_pages_fk; Type: FK CONSTRAINT; Schema: gp50; Owner: postgres
--

ALTER TABLE ONLY gp50.user_pages
    ADD CONSTRAINT user_pages_fk FOREIGN KEY (user_id) REFERENCES admin.users(user_id) ON DELETE CASCADE;


-- Completed on 2026-01-26 13:39:08

--
-- PostgreSQL database dump complete
--

\unrestrict nhDC4QYGHefFB8N1jaHQnZRHsflPFN5GqBnf66o4j6JBdcLkM7UfirYBBnBqH1o

